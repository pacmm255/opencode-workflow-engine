import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Agent, OpencodeClient } from "@opencode-ai/sdk/v2";
import { z } from "zod";
import { effortSchema, type WorkflowConfig } from "../config";
import { checkAbort, errorText, failure } from "../errors";
import { resolveModel, type ModelEntry, type ModelSelection } from "../models";
import { runsDirectory, validateRunID } from "../paths";
import { SavedWorkflows } from "../saved";
import { parseScript } from "../script/meta";
import { runScript } from "../runtime/host";
import { executeAgent } from "./executor";
import { validateSchema } from "./schema";
import { atomicJSON, cacheKey, Journal, ResumeCache } from "./journal";
import { report } from "./report";
import { Semaphore } from "./semaphore";
import { emptyUsage, type AgentState, type RunState } from "./state";

export type WorkflowInput = {
  script?: string; scriptPath?: string; name?: string; args?: unknown; resumeFromRunId?: string;
  background?: boolean; description?: string; tokenBudget?: number;
};
export type RunContext = {
  sessionID: string; agent: string; model: ModelSelection; abort?: AbortSignal;
  config: WorkflowConfig; catalog: ModelEntry[]; agents: Agent[];
  metadata?: (state: RunState) => void;
};
const agentOptions = z.object({
  label: z.string().max(200).optional(), phase: z.string().max(200).optional(),
  model: z.string().optional(), effort: effortSchema.optional(), variant: z.string().optional(),
  agentType: z.string().optional(), schema: z.record(z.string(), z.unknown()).optional(),
  isolation: z.literal("worktree").optional(), system: z.string().optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
  timeoutMs: z.number().int().positive().max(86_400_000).optional(), retries: z.number().int().min(0).max(10).optional(),
  schemaRetries: z.number().int().min(0).max(10).optional(),
}).strict();

type ActiveRun = { state: RunState; controller: AbortController; skips: Map<string, AbortController>; done: Promise<RunState> };

export class RunManager {
  private active = new Map<string, ActiveRun>();
  private closing = false;
  private notifyTimer?: ReturnType<typeof setInterval>;
  private notifying = false;
  private pending = new Map<string, RunState>();
  private lifecycle = new AbortController();
  private readonly requestTimeoutMs: number;
  constructor(readonly client: OpencodeClient, readonly directory: string,
    readonly root = runsDirectory(), readonly execute = executeAgent,
    options: { requestTimeoutMs?: number } = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 3000;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0 || this.requestTimeoutMs > 2_147_483_647)
      throw new Error("requestTimeoutMs must be a positive 32-bit integer");
  }

  /** Enforce deadlines even when a transport does not honor the passed signal. */
  private async request<T>(operation: (signal: AbortSignal) => PromiseLike<T>): Promise<T> {
    checkAbort(this.lifecycle.signal);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(failure("RequestTimeoutError", `Workflow progress request exceeded ${this.requestTimeoutMs} ms`)), this.requestTimeoutMs);
    const signal = AbortSignal.any([this.lifecycle.signal, deadline.signal]);
    let abort: (() => void) | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) { abort(); return; }
        Promise.resolve().then(() => { checkAbort(signal); return operation(signal); }).then(resolve, reject);
      });
    } finally {
      clearTimeout(timer);
      if (abort) signal.removeEventListener("abort", abort);
    }
  }

  private async writeControl(state: RunState, name: string): Promise<void> {
    if (!(await lstat(state.runDir)).isDirectory()) throw failure("RunNotFoundError", "Invalid workflow run directory");
    const path = join(state.runDir, name);
    try {
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile("User requested workflow control\n"); }
      finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await lstat(path)).isFile()) throw error;
    }
  }

  async recover(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const id of await readdir(this.root)) {
      if (!/^wf_[a-f0-9-]{36}$/.test(id)) continue;
      try {
        const state = await this.get(id);
        if (state.status === "running") {
          let live = false;
          try { process.kill(state.ownerPID, 0); live = true; } catch (error) { live = (error as NodeJS.ErrnoException).code === "EPERM"; }
          if (!live) {
            state.status = "interrupted"; state.finishedAt = Date.now();
            state.error = "The process exited before this run completed. Resume from its successful journal entries.";
            await atomicJSON(join(state.runDir, "run.json"), state);
          }
        }
        if (state.notification === "pending" && state.status !== "running") this.pending.set(id, state);
      } catch { /* Ignore unrelated projects and malformed records; get/status reports them directly. */ }
    }
    this.notifyTimer = setInterval(() => { void this.flushNotifications(); }, 1000);
    this.notifyTimer.unref();
  }

  async get(id: string): Promise<RunState> {
    validateRunID(id);
    const live = this.active.get(id);
    if (live) return structuredClone(live.state);
    const state: RunState = JSON.parse(await readFile(join(this.root, id, "run.json"), "utf8"));
    if (state.id !== id || resolve(state.directory) !== resolve(this.directory) || resolve(state.runDir) !== resolve(this.root, id))
      throw failure("RunNotFoundError", "Run does not belong to this project");
    return state;
  }

  async list(sessionID?: string): Promise<RunState[]> {
    const ids = await readdir(this.root).catch(() => [] as string[]);
    const rows = await Promise.all(ids.filter((id) => /^wf_[a-f0-9-]{36}$/.test(id)).map((id) => this.get(id).catch(() => undefined)));
    return rows.filter((row): row is RunState => !!row && (!sessionID || row.sessionID === sessionID)).sort((a, b) => b.startedAt - a.startedAt);
  }

  async stop(id: string): Promise<void> {
    const state = await this.get(id);
    if (state.status !== "running") return;
    await this.writeControl(state, "STOP");
    this.active.get(id)?.controller.abort(failure("RunAbortedError", "User stopped the workflow"));
  }

  async skip(id: string, agentID: string): Promise<void> {
    const state = await this.get(id);
    const agent = state.agents.find((agent) => agent.id === agentID);
    if (!/^a_[1-9]\d*$/.test(agentID) || !agent) throw failure("AgentNotFoundError", `Unknown agent ${agentID}`);
    if (state.status !== "running" || (agent.status !== "queued" && agent.status !== "running"))
      throw failure("AgentNotRunningError", `Agent ${agentID} is no longer running`);
    await this.writeControl(state, `SKIP_${agentID}`);
    this.active.get(id)?.skips.get(agentID)?.abort(failure("AgentSkippedError", "User skipped the agent"));
  }

  async start(input: WorkflowInput, context: RunContext): Promise<{ state: RunState; done: Promise<RunState> }> {
    if (this.closing) throw failure("RunAbortedError", "Plugin is shutting down");
    if (input.tokenBudget !== undefined && (!Number.isSafeInteger(input.tokenBudget) || input.tokenBudget < 0)) throw failure("WorkflowInputError", "tokenBudget must be a nonnegative integer");
    const saved = new SavedWorkflows(this.directory);
    const script = await saved.load(input);
    const { meta } = parseScript(script);
    let cache = new ResumeCache([]);
    if (input.resumeFromRunId) {
      const previous = await this.get(input.resumeFromRunId);
      cache = new ResumeCache(await new Journal(join(previous.runDir, "journal.jsonl")).read());
    }
    const id = `wf_${randomUUID()}`;
    const runDir = join(this.root, id);
    const controller = new AbortController();
    const state: RunState = {
      id, name: input.description ?? meta.name ?? input.name ?? "Workflow", status: "running", sessionID: context.sessionID,
      directory: this.directory, runDir, scriptPath: join(runDir, "script.js"), startedAt: Date.now(), ownerPID: process.pid,
      background: input.background ?? false, phases: meta.phases?.map((phase) => phase.title) ?? [], agents: [], usage: emptyUsage(),
      logs: [], warnings: [], resumeFromRunId: input.resumeFromRunId, launchAgent: context.agent, launchModel: context.model,
    };
    await mkdir(join(runDir, "agents"), { recursive: true, mode: 0o700 });
    await writeFile(state.scriptPath, script, { mode: 0o600 });
    await atomicJSON(join(runDir, "args.json"), input.args ?? null);
    await atomicJSON(join(runDir, "run.json"), state);
    const active: ActiveRun = { state, controller, skips: new Map(), done: undefined! };
    this.active.set(id, active);
    active.done = this.run(active, input, context, script, cache, saved);
    return { state: structuredClone(state), done: active.done };
  }

  private async run(active: ActiveRun, input: WorkflowInput, context: RunContext, script: string, cache: ResumeCache, saved: SavedWorkflows): Promise<RunState> {
    const { state, controller, skips } = active;
    const journal = new Journal(join(state.runDir, "journal.jsonl"));
    const semaphore = new Semaphore(context.config.limits.maxConcurrency);
    const pending = new Set<Promise<unknown>>();
    let persistTail = Promise.resolve();
    const persist = () => {
      const snapshot = structuredClone(state);
      persistTail = persistTail.then(() => atomicJSON(join(state.runDir, "run.json"), snapshot));
      return persistTail;
    };
    const abort = () => controller.abort(context.abort?.reason ?? failure("RunAbortedError", "Invoking session aborted"));
    if (!state.background && context.abort) {
      context.abort.addEventListener("abort", abort, { once: true });
      if (context.abort.aborted) abort();
    }
    const controls = setInterval(() => {
      void access(join(state.runDir, "STOP")).then(() => controller.abort(failure("RunAbortedError", "Stop file detected"))).catch(() => {});
      for (const [id, skip] of skips) void access(join(state.runDir, `SKIP_${id}`))
        .then(() => skip.abort(failure("AgentSkippedError", "Skip file detected"))).catch(() => {});
    }, 1000);
    let progressPending: Promise<void> | undefined;
    const progress = (): Promise<void> => {
      if (progressPending) return progressPending;
      progressPending = (async () => { try {
        const snapshot = structuredClone(state);
        if (!state.background) context.metadata?.(snapshot);
        const { data: session } = await this.request((signal) => this.client.session.get({ sessionID: state.sessionID, directory: this.directory }, { signal }));
        if (session) await this.request((signal) => this.client.session.update({ sessionID: state.sessionID, directory: this.directory,
          metadata: { ...session.metadata, workflow: snapshot } }, { signal }));
      } catch { /* UI progress must not fail a durable run. */ }
      finally { progressPending = undefined; } })();
      return progressPending;
    };
    const progressTimer = setInterval(() => { void progress(); }, 1000);
    const toast = (message: string, variant: "info" | "success" | "error" = "info") => {
      if (context.config.ui.toasts) void this.request((signal) => this.client.tui.showToast({
        title: state.name, message, variant,
      }, { signal })).catch(() => {});
    };
    const warn = (message: string) => { if (state.warnings.length < 1000 && !state.warnings.includes(message)) state.warnings.push(message); };
    const recordFailure = (error: unknown) => { if (state.logs.length < 1000) state.logs.push(errorText(error).slice(0, 8000)); };
    const callAgent = async (prompt: string, raw: Record<string, unknown>): Promise<unknown> => {
      checkAbort(controller.signal);
      const options = agentOptions.parse(raw);
      if (options.schema) validateSchema(options.schema);
      const agentType = options.agentType ?? context.config.defaults.agent;
      const agent = context.agents.find((candidate) => candidate.name === agentType);
      if (!agent || agent.mode === "primary") throw failure("AgentConfigurationError", `Agent is unavailable as a subagent: ${agentType}`);
      const model = resolveModel({ config: context.config, catalog: context.catalog, sessionModel: context.model,
        requested: options.model, agentModel: options.agentType && agent.model ? { ...agent.model, variant: agent.variant } : undefined,
        effort: options.effort ?? context.config.defaults.effort ?? undefined,
        variant: options.variant, onWarning: warn });
      if (state.agents.length >= context.config.limits.maxAgents) throw failure("AgentCapError", `Maximum ${context.config.limits.maxAgents} agents per run`);
      const key = cacheKey(prompt, raw);
      const cached = cache.take(key);
      if (!cached.hit && input.tokenBudget !== undefined && state.usage.output + state.usage.reasoning >= input.tokenBudget)
        throw failure("BudgetExceededError", `Output token budget ${input.tokenBudget} exhausted`);
      const sequence = state.agents.length + 1;
      const row: AgentState = { id: `a_${sequence}`, sequence, label: options.label ?? `Agent ${sequence}`, phase: options.phase,
        model: `${model.providerID}/${model.modelID}${model.variant ? `/${model.variant}` : ""}`,
        status: cached.hit ? "cached" : "queued", usage: emptyUsage() };
      state.agents.push(row);
      if (row.phase && !state.phases.includes(row.phase)) state.phases.push(row.phase);
      const writeRow = (value?: unknown) => atomicJSON(join(state.runDir, "agents", `${row.id}.json`), { ...row, prompt, options, value });
      if (cached.hit) {
        await journal.append({ type: "agent.cached", sequence, agentId: row.id, key, value: cached.value, phase: row.phase });
        await writeRow(cached.value); await persist(); return cached.value;
      }
      const skip = new AbortController();
      skips.set(row.id, skip);
      const signal = AbortSignal.any([controller.signal, skip.signal]);
      let release: (() => void) | undefined;
      try {
        await persist();
        release = await semaphore.acquire(signal);
        checkAbort(signal);
        if (input.tokenBudget !== undefined && state.usage.output + state.usage.reasoning >= input.tokenBudget)
          throw failure("BudgetExceededError", `Output token budget ${input.tokenBudget} exhausted before dispatch`);
        row.status = "running";
        await journal.append({ type: "agent.start", agentId: row.id, sequence, key, prompt, options, model, phase: row.phase });
        const result = await this.execute({ client: this.client, parentID: state.sessionID, directory: this.directory, prompt,
          options: { ...options, agentType, timeoutMs: options.timeoutMs ?? context.config.limits.agentTimeoutMs,
            retries: options.retries ?? context.config.defaults.retries }, model, signal, availableAgents: context.agents,
          workflow: { runId: state.id, agentId: row.id },
          onSession: async (sessionID, directory) => {
            row.sessionID = sessionID; row.directory = directory;
            await journal.append({ type: "agent.session", agentId: row.id, sessionID, directory });
            await writeRow(); await persist();
          },
          onUsage: (delta) => { for (const key of ["input", "output", "reasoning", "cost"] as const) { row.usage[key] += delta[key]; state.usage[key] += delta[key]; } },
        });
        checkAbort(signal);
        row.status = result.status; row.error = result.error; row.attempts = result.attempts;
        row.sessionID = result.sessionID ?? row.sessionID; row.directory = result.directory ?? row.directory;
        await journal.append({ type: result.status === "completed" ? "agent.result" : result.status === "skipped" ? "agent.skipped" : "agent.error",
          agentId: row.id, sequence, key, value: result.value, error: row.error, usage: row.usage, phase: row.phase });
        await writeRow(result.value); await persist(); return result.value;
      } catch (error) {
        row.status = skip.signal.aborted ? "skipped" : "failed"; row.error = errorText(error);
        await journal.append({ type: row.status === "skipped" ? "agent.skipped" : "agent.error", agentId: row.id, sequence, key, error: row.error });
        await writeRow(); await persist();
        if (skip.signal.aborted && !controller.signal.aborted) return null;
        throw error;
      } finally { release?.(); skips.delete(row.id); }
    };
    try {
      await journal.append({ type: "run.start", runId: state.id, resumeFromRunId: input.resumeFromRunId });
      toast(`Workflow started: ${state.id}`);
      state.result = await runScript({ script, args: input.args ?? null, signal: controller.signal, limits: context.config.limits,
        tokenBudget: input.tokenBudget, getSpent: () => state.usage.output + state.usage.reasoning,
        onAgent: (prompt, options) => {
          const operation = callAgent(prompt, options).catch((error) => { recordFailure(error); throw error; });
          pending.add(operation);
          void operation.finally(() => pending.delete(operation)).catch(() => {});
          return operation;
        },
        onLog: (message) => {
          if (state.logs.length >= 1000) return;
          const value = message.slice(0, 8000);
          state.logs.push(value);
          void journal.append({ type: "log", message: value }).catch((error) => controller.abort(error));
        },
        onPhase: (title) => {
          state.phase = title;
          if (!state.phases.includes(title)) state.phases.push(title);
          void journal.append({ type: "phase", title, agents: state.agents.length }).catch((error) => controller.abort(error));
        },
        onWorkflow: (reference) => saved.load(typeof reference === "string" ? { name: reference } : reference),
      });
      checkAbort(controller.signal);
      if (pending.size) warn("The script returned with unfinished agent calls; these calls were aborted. Await every agent or orchestration promise.");
      state.status = "completed";
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      state.status = name === "RunTimeoutError" ? "timeout" : controller.signal.aborted ? "aborted" : "failed";
      state.error = errorText(error);
    } finally {
      controller.abort(failure("RunAbortedError", "Workflow execution ended"));
      await Promise.allSettled([...pending]);
      clearInterval(controls); clearInterval(progressTimer);
      context.abort?.removeEventListener("abort", abort);
      state.finishedAt = Date.now();
      if (state.background) state.notification = "pending";
      try {
        await atomicJSON(join(state.runDir, "result.json"), state.result ?? null);
        await journal.append({ type: state.status === "completed" ? "run.done" : "run.error", status: state.status, error: state.error, usage: state.usage });
        await persist();
      } catch (error) { state.status = "failed"; state.error = `Persistence failure: ${errorText(error)}`; }
      await progressPending;
      await progress();
      toast(`Workflow ${state.status}: ${state.id}`, state.status === "completed" ? "success" : "error");
      this.active.delete(state.id);
      if (state.background) { this.pending.set(state.id, structuredClone(state)); void this.flushNotifications(); }
    }
    return structuredClone(state);
  }

  private async flushNotifications(): Promise<void> {
    if (this.notifying || this.closing || !this.pending.size) return;
    this.notifying = true;
    try {
      for (const [id, state] of this.pending) {
        if (this.closing) break;
        try {
          const { data: statuses, error } = await this.request((signal) => this.client.session.status({ directory: this.directory }, { signal }));
          if (error || !statuses || (statuses[state.sessionID] && statuses[state.sessionID]!.type !== "idle")) continue;
          const { data: parent } = await this.request((signal) => this.client.session.get({ sessionID: state.sessionID, directory: this.directory }, { throwOnError: true, signal }));
          const current = parent.model;
          await this.request((signal) => this.client.session.promptAsync({ sessionID: state.sessionID, directory: this.directory,
            agent: parent.agent ?? state.launchAgent,
            model: current ? { providerID: current.providerID, modelID: current.id } : state.launchModel,
            variant: current ? (current.variant === "default" ? undefined : current.variant) : state.launchModel.variant,
            parts: [{ type: "text", synthetic: true, text: `<workflow_result runId="${state.id}" state="${state.status}">\n${report(state)}\n</workflow_result>` }],
          }, { throwOnError: true, signal }));
          state.notification = "delivered";
          await atomicJSON(join(state.runDir, "run.json"), state);
          this.pending.delete(id);
        } catch (error) {
          if (this.closing) break; // Keep undelivered reports pending for recovery.
          state.notification = "failed"; state.warnings.push(`Background notification failed; retrieve with workflow_runs status: ${errorText(error)}`);
          await atomicJSON(join(state.runDir, "run.json"), state).catch(() => {});
          this.pending.delete(id);
        }
      }
    } finally { this.notifying = false; }
  }

  async dispose(): Promise<void> {
    this.closing = true;
    this.lifecycle.abort(failure("RunAbortedError", "Plugin disposed"));
    if (this.notifyTimer) clearInterval(this.notifyTimer);
    for (const run of this.active.values()) run.controller.abort(failure("RunAbortedError", "Plugin disposed"));
    await Promise.allSettled([...this.active.values()].map((run) => run.done));
  }
}
