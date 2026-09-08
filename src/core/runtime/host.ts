import { Worker } from "node:worker_threads";
import { validateScript } from "../script/validate.ts";
import { errorData, jsonValue, runtimeError, type HostMessage, type RuntimeLimits, type WorkerInput, type WorkerMessage, type WorkflowReference } from "./protocol.ts";

export interface RunScriptOptions {
  script: string;
  args?: unknown;
  signal: AbortSignal;
  limits: RuntimeLimits;
  tokenBudget?: number | null;
  onAgent: (prompt: string, opts: Record<string, unknown>) => Promise<unknown>;
  onLog: (message: string) => void;
  onPhase: (title: string) => void;
  onWorkflow?: (reference: WorkflowReference) => Promise<string>;
  getSpent?: () => number;
}

/** The owner must abort/drain its agents when this settles, including unawaited calls. */
export async function runScript(options: RunScriptOptions): Promise<unknown> {
  const { body } = validateScript(options.script);
  for (const key of ["syncTimeoutMs", "scriptIdleTimeoutMs", "runTimeoutMs", "maxItems"] as const) {
    const value = options.limits[key];
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw runtimeError("RuntimeConfigError", `${key} must be a positive 32-bit integer`);
  }
  if (options.tokenBudget != null && (!Number.isFinite(options.tokenBudget) || options.tokenBudget < 0)) throw runtimeError("RuntimeConfigError", "tokenBudget must be a finite nonnegative number or null");
  const argsJSON = jsonValue(options.args, "Workflow args");
  if (options.signal.aborted) throw runtimeError("RunAbortedError", "Workflow was aborted");
  const readSpent = () => {
    const value = options.getSpent?.() ?? 0;
    if (!Number.isFinite(value) || value < 0) throw runtimeError("RuntimeConfigError", "Spent tokens must be a finite nonnegative number");
    return value;
  };
  const initialSpent = readSpent();
  return new Promise((resolve, reject) => {
    let worker: Worker;
    let settled = false;
    let ready = false;
    let pending = 0;
    let activeTimers = 0;
    let lastActivity = Date.now();
    let lastPong = lastActivity;
    let watchdog: ReturnType<typeof setInterval> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let startup: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: unknown, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      clearTimeout(timeout);
      clearTimeout(startup);
      options.signal.removeEventListener("abort", abort);
      if (worker) void worker.terminate().catch(() => {});
      if (error !== undefined) reject(error);
      else resolve(value);
    };
    const abort = () => finish(runtimeError("RunAbortedError", "Workflow was aborted"));
    const post = (message: HostMessage) => {
      if (!settled) { try { worker.postMessage(message); } catch (error) { finish(error); } }
    };
    try {
      const data: WorkerInput = { body, argsJSON, limits: options.limits, tokenBudget: options.tokenBudget ?? null, spent: initialSpent };
      // build.ts emits this entry next to the bundled server module.
      worker = new Worker(new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url), { workerData: data });
    } catch (error) {
      finish(runtimeError("WorkerInitializationError", `Could not initialize isolated workflow worker: ${errorData(error).message}`));
      return;
    }
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) { abort(); return; }
    startup = setTimeout(() => finish(runtimeError("WorkerInitializationError", "Isolated workflow worker did not initialize within 5 seconds")), 5_000);
    timeout = setTimeout(() => finish(runtimeError("RunTimeoutError", `Workflow exceeded ${options.limits.runTimeoutMs} ms`)), options.limits.runTimeoutMs);
    const interval = Math.max(10, Math.min(250, Math.floor(options.limits.scriptIdleTimeoutMs / 4)));
    watchdog = setInterval(() => {
      if (!ready || settled) return;
      const now = Date.now();
      if (now - lastPong > options.limits.scriptIdleTimeoutMs || (!pending && !activeTimers && now - lastActivity > options.limits.scriptIdleTimeoutMs)) {
        finish(runtimeError("ScriptStalledError", `Workflow stopped making progress for ${options.limits.scriptIdleTimeoutMs} ms`));
      } else post({ type: "ping" });
    }, interval);
    worker.on("error", error => finish(ready ? error : runtimeError("WorkerInitializationError", error.message)));
    worker.on("exit", code => { if (!settled) finish(runtimeError("WorkerTerminatedError", `Workflow worker exited unexpectedly (${code})`)); });
    worker.on("message", (message: WorkerMessage) => {
      if (settled) return;
      try {
        switch (message.type) {
          case "ready": ready = true; clearTimeout(startup); lastPong = lastActivity = Date.now(); break;
          case "pong": lastPong = Date.now(); activeTimers = message.timers; break;
          case "done": finish(undefined, JSON.parse(jsonValue(JSON.parse(message.value), "Workflow result"))); break;
          case "error": finish(runtimeError(message.error.name, message.error.message)); break;
          case "log": lastActivity = Date.now(); options.onLog(message.value); break;
          case "phase": lastActivity = Date.now(); options.onPhase(message.value); break;
          case "call": {
            lastActivity = Date.now();
            pending++;
            void (async () => {
              let value: string | undefined;
              let error: ReturnType<typeof errorData> | undefined;
              try {
                const args = JSON.parse(message.payload) as [WorkflowReference, Record<string, unknown>];
                jsonValue(args, "Workflow API arguments");
                if (message.method === "agent") value = jsonValue(await options.onAgent(args[0] as string, args[1]), "Agent result");
                else {
                  if (!options.onWorkflow) throw runtimeError("WorkflowNotFoundError", `Unknown workflow: ${args[0]}`);
                  value = jsonValue(await options.onWorkflow(args[0]), "Workflow source");
                }
              } catch (cause) { error = errorData(cause); }
              finally { pending--; }
              if (settled) return;
              lastActivity = Date.now();
              try { post({ type: "reply", id: message.id, value, error, spent: readSpent() }); }
              catch (cause) { finish(cause); }
            })();
            break;
          }
        }
      } catch (error) { finish(error); }
    });
  });
}
