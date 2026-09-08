import { parentPort, workerData } from "node:worker_threads";
import { validateScript } from "../script/validate.ts";
import { executeSandbox } from "./sandbox.ts";
import { errorData, jsonValue, runtimeError, type HostMessage, type WorkerInput, type WorkerMessage, type WorkflowReference } from "./protocol.ts";

if (!parentPort) throw new Error("Workflow worker must run in a worker thread");
const port = parentPort;
const input = workerData as WorkerInput;
let spent = input.spent;
let sequence = 0;
let timerSequence = 0;
let finished = false;
const pending = new Map<number, (value: string) => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const childNames = new Map<string, number>();
const post = (message: WorkerMessage) => { if (!finished) port.postMessage(message); };

function finish(error?: unknown, value?: string): void {
  if (finished) return;
  if (error !== undefined) post({ type: "error", error: errorData(error) });
  else post({ type: "done", value: value ?? "null" });
  finished = true;
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  pending.clear();
  port.close();
}

function rpc(method: "agent" | "workflow", payload: string): Promise<string> {
  if (finished) return Promise.resolve(jsonValue({ error: { name: "RunAbortedError", message: "Workflow has finished" } }));
  const id = ++sequence;
  return new Promise(resolve => { pending.set(id, resolve); post({ type: "call", method, payload, id }); });
}

async function call(method: "agent" | "workflow", payload: string): Promise<string> {
  if (method === "agent") return rpc(method, payload);
  try {
    const [reference, args] = JSON.parse(payload) as [WorkflowReference, unknown];
    const loaded = JSON.parse(await rpc("workflow", jsonValue([reference]))) as { value?: string; error?: { name: string; message: string } };
    if (loaded.error) return jsonValue(loaded);
    const { meta, body } = validateScript(loaded.value!);
    const name = typeof reference === "string" ? reference : meta.name ?? reference.scriptPath;
    const count = (childNames.get(name) ?? 0) + 1;
    childNames.set(name, count);
    const group = `▸ ${name}${count === 1 ? "" : ` #${count}`}`;
    post({ type: "phase", value: group });
    const value = await executeSandbox({ ...input, body, argsJSON: jsonValue(args), group, bridge });
    return jsonValue({ value: JSON.parse(value) });
  } catch (error) { return jsonValue({ error: errorData(error) }); }
}

const bridge = {
  call,
  emit: (type: "log" | "phase", value: string) => post({ type, value }),
  spent: () => spent,
  timer(callback: () => void, delay: number): number {
    if (finished) throw runtimeError("RunAbortedError", "Workflow has finished");
    if (timers.size >= input.limits.maxItems) throw runtimeError("TimerLimitError", "Too many pending timers");
    const id = ++timerSequence;
    const timer = setTimeout(() => {
      timers.delete(id);
      if (finished) return;
      try { callback(); } catch (error) { finish(error); }
    }, delay);
    timers.set(id, timer);
    return id;
  },
  clearTimer(id: number): void {
    const timer = timers.get(id);
    if (timer) { clearTimeout(timer); timers.delete(id); }
  },
};

port.on("message", (message: HostMessage) => {
  if (finished) return;
  if (message.type === "ping") post({ type: "pong", timers: timers.size });
  else {
    spent = message.spent;
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    resolve?.(message.error ? jsonValue({ error: message.error }) : `{"value":${message.value ?? "null"}}`);
  }
});
process.on("unhandledRejection", error => finish(error));
process.on("uncaughtException", error => finish(error));
post({ type: "ready" });
try {
  Promise.resolve(executeSandbox({ ...input, bridge })).then(value => finish(undefined, value), error => finish(error));
} catch (error) { finish(error); }
