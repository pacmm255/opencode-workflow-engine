import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { errorText } from "../errors";
import { resolveModel } from "../models";
import { preparePlan } from "../plan";
import type { RunContext, RunManager } from "../run/manager";
import type { RunState } from "../run/state";
import { exactUltracodeVariant } from "../ultracode";
import { workspaceFingerprint } from "./fingerprint";
import { contractSchema, decisionSchema, goalInput, goalScope, verificationSchema } from "./prompts";
import { goalResultKey, goalSummary, type GoalOperation, type GoalState } from "./state";
import { GoalStore } from "./store";

type Options = {
  intervalMs?: number; now?: () => number; fingerprint?: (directory: string) => Promise<string>;
  requestTimeoutMs?: number;
  context(goal: GoalState): Promise<RunContext>;
};

/** Persistent single-owner supervisor. Individual operations are finite; the goal has no aggregate cap. */
export class GoalManager {
  readonly owner = randomUUID();
  private timer?: ReturnType<typeof setInterval>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private closing = false;
  private lifecycle = new AbortController();
  private ticking?: Promise<void>;
  private live = new Map<string, Promise<RunState>>();
  private now: () => number;
  private fingerprint: (directory: string) => Promise<string>;
  private lastPublish = new Map<string, number>();
  private reconciliation = new Map<string, number>();
  constructor(readonly client: OpencodeClient, readonly runs: RunManager, readonly store: GoalStore, readonly options: Options) {
    this.now = options.now ?? Date.now;
    this.fingerprint = options.fingerprint ?? workspaceFingerprint;
    runs.admit = context => {
      if (context.goal) return;
      if (store.runnable().some(goal => goal.mode === "active" || goal.operation))
        throw new Error("A workflow goal owns this project's scheduling. Pause it before starting an independent workflow; Ultracode settings can remain enabled.");
    };
    runs.onStop = run => {
      if (!run.goal) return;
      const goal = store.get(run.goal.id);
      if (goal?.mode === "active") store.control(goal.id, "pause");
    };
    if (options.intervalMs !== 0) {
      this.heartbeat = setInterval(() => {
        try { if (!this.closing && store.owns(this.owner, this.now())) store.claim(this.owner, this.now(), 15_000); } catch { /* Guard fences dispatch if the lease cannot be renewed. */ }
      }, 3000);
      this.heartbeat.unref();
      this.timer = setInterval(() => { void this.tick(); }, options.intervalMs ?? 1000);
      this.timer.unref();
    }
  }
  start(input: Parameters<GoalStore["create"]>[0]): GoalState {
    if (this.closing) throw new Error("Goal supervisor is shutting down");
    if (input.agent === "plan") throw new Error("Switch out of Plan mode before starting a persistent execution goal.");
    const goal = this.store.create(input, this.now());
    void this.publish(goal);
    return goal;
  }
  control(id: string, action: "pause" | "resume" | "stop" | "edit", objective?: string): GoalState {
    const goal = this.store.control(id, action, objective);
    void this.publish(goal);
    if (goal.operation) void this.runs.stop(goal.operation.runID, false).catch(() => {});
    return goal;
  }
  tick(): Promise<void> {
    if (this.closing) return Promise.resolve();
    if (this.ticking) return this.ticking;
    this.ticking = this.step().catch(async error => {
      // Storage/transport faults never become an invisible successful completion.
      try { await this.request(signal => this.client.tui.showToast({ title: "Workflow goal", message: errorText(error).slice(0, 500), variant: "error" }, { signal }), 3000); } catch { /* Retain durable state for the next reconciliation. */ }
    }).finally(() => { this.ticking = undefined; });
    return this.ticking;
  }
  private async request<T>(operation: (signal: AbortSignal) => PromiseLike<T>, timeout = this.options.requestTimeoutMs ?? 15_000): Promise<T> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error("Goal request timed out; waiting for the host")), timeout);
    const signal = AbortSignal.any([deadline.signal, this.lifecycle.signal]);
    let abort: (() => void) | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) { abort(); return; }
        Promise.resolve().then(() => { signal.throwIfAborted(); return operation(signal); }).then(resolve, reject);
      });
    } finally { clearTimeout(timer); if (abort) signal.removeEventListener("abort", abort); }
  }
  private guard(id: string, op: GoalOperation) {
    const current = this.store.get(id);
    if (this.closing || !this.store.owns(this.owner, this.now()) || current?.mode !== "active"
      || current.generation !== op.generation || current.operation?.id !== op.id)
      throw new Error("Goal dispatch cancelled or ownership changed");
  }
  private async step() {
    if (!this.store.claim(this.owner, this.now(), 15_000)) {
      for (const id of this.live.keys()) await this.runs.stop(id, false).catch(() => {});
      return;
    }
    const candidates = this.store.runnable();
    // Reconcile every old operation before another goal may use the project.
    const pending = candidates.filter(goal => goal.operation);
    for (const goal of pending) await this.settle(goal);
    if (this.closing) return;
    const remaining = this.store.runnable();
    if (!remaining.some(goal => goal.operation)) {
      const goal = remaining.find(goal => goal.mode === "active" && goal.nextWakeAt <= this.now());
      if (goal) {
        try { await this.dispatch(goal); }
        catch (error) { this.defer(goal.id, errorText(error), goal.generation); }
      }
    }
    for (const goal of this.store.runnable()) if ((this.lastPublish.get(goal.id) ?? 0) + 5000 < this.now()) await this.publish(goal);
    for (const goal of this.store.notices()) await this.notify(goal);
  }
  private async dispatch(goal: GoalState) {
    const { data: parent, response } = await this.request(signal => this.client.session.get({ sessionID: goal.sessionID, directory: goal.directory }, { signal }));
    if (response?.status === 404) { this.control(goal.id, "stop"); return; }
    if (!parent) throw new Error("Parent session is unavailable; waiting for the server.");
    if (parent.parentID) { this.block(goal.id, "Goals require a top-level session."); return; }
    if (parent.agent === "plan") { this.block(goal.id, "Switch out of Plan mode, then resume the goal."); return; }
    const { data: statuses } = await this.request(signal => this.client.session.status({ directory: goal.directory }, { signal, throwOnError: true }));
    if (statuses[goal.sessionID] && statuses[goal.sessionID]!.type !== "idle") return;
    if ((await this.request(() => this.runs.list())).some(run => run.status === "running")) return;
    let context = await this.request(() => this.options.context(goal));
    // Never silently move a missing selected model to another provider.
    const model = resolveModel({ config: context.config, catalog: context.catalog, sessionModel: context.model,
      requested: context.config.models.allowed.length ? context.config.models.allowed[0] : undefined });
    if (!context.config.models.allowed.length && context.config.models.default !== "session"
      && !context.catalog.some(entry => entry.id === context.config.models.default))
      throw new Error("The configured default goal model is unavailable; waiting for configuration repair.");
    const entry = context.catalog.find(entry => entry.id === `${model.providerID}/${model.modelID}`);
    if (!entry?.toolcall || entry.status === "deprecated") throw new Error("The configured goal model is unavailable; repair the workflow pool to continue.");
    if (context.ultracode?.effort) model.variant = exactUltracodeVariant(entry, context.ultracode.effort) ?? model.variant;
    context = { ...context, model, goalScope: goalScope(goal) };
    const input = goalInput(goal, context);
    // Validate a whole generated plan BEFORE reserving and launching any worker.
    if (input.plan) preparePlan(input.plan, context);
    const fingerprint = goal.stage === "verifying" ? await this.request(() => this.fingerprint(goal.directory), 30_000) : undefined;
    const operation: GoalOperation = { id: randomUUID(), runID: `wf_${randomUUID()}`, generation: goal.generation,
      stage: goal.stage, owner: this.owner, startedAt: this.now(), ...(fingerprint ? { fingerprint } : {}) };
    const reserved = this.store.change(goal.id, "reserved", current => {
      if (this.closing || !this.store.owns(this.owner, this.now()) || current.mode !== "active" || current.operation || current.generation !== goal.generation) return false;
      current.operation = operation;
      if (operation.stage === "executing") current.cycle++;
    }, operation, this.now());
    if (!reserved) return;
    try {
      const run = await this.runs.start(input, { ...context,
        goal: { id: goal.id, objectiveRevision: goal.objectiveRevision, operation },
        // The supervisor, not Ultracode's parent-result continuation, owns these runs.
        guard: () => this.guard(goal.id, operation),
      });
      this.live.set(operation.runID, run.done);
      void run.done.finally(() => { this.live.delete(operation.runID); void this.tick(); }).catch(() => {});
      await this.publish(reserved);
    } catch (error) {
      // Reservation survives a partial start. Recovery inspects the reserved run identity.
      this.defer(goal.id, errorText(error), goal.generation);
    }
  }
  private async settle(goal: GoalState) {
    const op = goal.operation!;
    if (this.live.has(op.runID)) {
      if (goal.mode !== "active" || goal.generation !== op.generation) await this.runs.stop(op.runID, false);
      return;
    }
    let run: RunState;
    try { run = await this.runs.get(op.runID); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // run.json is durable before the first child can be created. No file => no dispatch.
      this.store.change(goal.id, "undispatched", current => {
        if (current.operation?.id !== op.id) return false;
        delete current.operation;
        current.stage = current.criteria.length ? "planning" : "defining";
      }, op, this.now());
      return;
    }
    if (run.goal?.id !== goal.id || run.goal.operation.id !== op.id) { this.block(goal.id, "Reserved run identity does not match; reconciliation needs repair."); return; }
    if (op.owner !== this.owner || run.status === "interrupted" || /could not confirm child abort/i.test(JSON.stringify([run.error, ...run.agents.map(agent => agent.error)]))) {
      if (!(await this.reconcile(run))) return;
      if (run.status === "running") {
        await this.runs.reconcileInterrupted(run.id);
        run = await this.runs.get(run.id);
        if (run.status === "running") return;
      }
    }
    if (run.status === "running") return;
    const valid = goal.mode === "active" && goal.generation === op.generation;
    let result: unknown;
    let fingerprint: string | undefined;
    const clean = run.status === "completed" && run.result !== null && run.result !== undefined
      && !run.agents.some(agent => !["completed"].includes(agent.status)) && !run.warnings.some(warning => /unfinished agent/.test(warning));
    let problem: string | undefined;
    if (valid && clean) {
      try {
        result = op.stage === "defining" ? contractSchema.parse(run.result) : op.stage === "planning" ? decisionSchema.parse(run.result)
          : op.stage === "verifying" ? verificationSchema.parse(run.result) : run.result;
        if (op.stage === "verifying") {
          const evidence = (result as ReturnType<typeof verificationSchema.parse>).evidence;
          for (const item of evidence) if (item.met) {
            // URLs are reviewer observations; local evidence must actually exist, not just look like a citation.
            if (/^https?:\/\//.test(item.artifact)) continue;
            const file = isAbsolute(item.artifact) ? item.artifact : resolve(goal.directory, item.artifact);
            if (!item.artifact || !(await stat(file).catch(() => undefined))?.isFile()) item.met = false;
          }
          fingerprint = await this.request(() => this.fingerprint(goal.directory), 30_000);
        }
      } catch (error) { problem = errorText(error); }
    } else if (valid) problem = [run.error, ...run.agents.filter(agent => agent.error).map(agent => agent.error)].filter(Boolean).join("; ") || `Workflow ${run.status}; unfinished or skipped work remains unverified.`;
    const next = this.store.change(goal.id, "settled", current => {
      if (!this.store.owns(this.owner, this.now()) || current.operation?.id !== op.id) return false;
      delete current.operation;
      current.lastRunID = run.id;
      for (const key of ["input", "output", "reasoning", "cost"] as const) current.usage[key] += run.usage[key];
      if (current.mode !== "active" || current.generation !== op.generation) return;
      if (run.status === "aborted" && !/Plugin disposed|Goal dispatch cancelled|ownership changed|Goal supervisor interrupted/.test(run.error ?? "")) {
        current.mode = "paused"; current.generation++; current.reason = "Goal-owned work was stopped. Resume explicitly to continue."; return;
      }
      if (problem) {
        current.evidence = []; current.reason = problem.slice(0, 8000);
        current.stage = current.criteria.length ? "planning" : "defining";
        current.failures++;
        current.nextWakeAt = this.now() + this.backoff(current.failures);
        if (/permission.{0,80}(?:denied|reject)|(?:denied|reject).{0,80}permission|authorization required|could not confirm child abort/i.test(problem)) {
          current.mode = "blocked"; current.notification = "pending";
        }
        return;
      }
      current.failures = 0; current.nextWakeAt = 0; current.reason = undefined;
      if (op.stage === "defining") {
        const contract = result as ReturnType<typeof contractSchema.parse>;
        current.criteria = [...new Set(contract.criteria)]; current.summary = contract.summary; current.stage = "verifying";
      } else if (op.stage === "planning") {
        const decision = result as ReturnType<typeof decisionSchema.parse>;
        current.summary = decision.summary;
        if (decision.decision === "workflow" && decision.plan) { current.plan = decision.plan; current.stage = "executing"; }
        else if (decision.decision === "verify") current.stage = "verifying";
        else if (decision.decision === "blocked") {
          current.mode = "blocked"; current.reason = decision.reason || "The planner requires user input."; current.notification = "pending";
        } else { current.reason = decision.reason || "Waiting for a useful next step."; current.nextWakeAt = this.now() + 30_000; }
      } else if (op.stage === "executing") {
        current.summary = `Workflow ${current.cycle} finished; checking all goal criteria independently.`;
        current.plan = undefined; current.evidence = []; current.stage = "verifying";
      } else {
        const verification = result as ReturnType<typeof verificationSchema.parse>;
        current.summary = verification.summary;
        const exact = verification.evidence.length === current.criteria.length && current.criteria.every(criterion => verification.evidence.filter(item => item.criterion === criterion).length === 1);
        const fresh = !!fingerprint && op.fingerprint === fingerprint;
        current.evidence = exact && fresh ? verification.evidence : [];
        if (exact && fresh && verification.evidence.every(item => item.met && item.artifact.trim()) && !verification.blocker) {
          current.mode = "completed"; current.verifiedAt = this.now(); current.fingerprint = fingerprint; current.notification = "pending";
        } else if (verification.blocker) {
          current.mode = "blocked"; current.reason = verification.blocker; current.notification = "pending";
        } else {
          current.stage = "planning";
          current.reason = !fresh ? "Workspace inputs changed during verification; fresh checks are required." : !exact ? "Verification did not cover every criterion exactly once." : "Some acceptance criteria remain unmet or lack evidence.";
        }
      }
    }, { operation: op, runID: run.id, status: run.status, result, problem, fingerprint, usage: run.usage }, this.now());
    if (next) await this.publish(next);
  }
  private async reconcile(run: RunState): Promise<boolean> {
    // A dead PID/expired lease is NOT proof its child sessions have stopped.
    const { data: children } = await this.request(signal => this.client.session.children({ sessionID: run.sessionID, directory: run.directory }, { signal, throwOnError: true }));
    const owned = new Map(run.agents.filter(agent => agent.sessionID).map(agent => [agent.sessionID!, agent.directory ?? run.directory]));
    for (const child of children) if ((child.metadata?.workflow as { runId?: string } | undefined)?.runId === run.id) owned.set(child.id, child.directory);
    await this.runs.stop(run.id, false);
    for (const [sessionID, directory] of owned) {
      const { data } = await this.request(signal => this.client.session.abort({ sessionID, directory }, { signal, throwOnError: true }));
      if (!data) return false;
    }
    const { data: statuses } = await this.request(signal => this.client.session.status({ directory: run.directory }, { signal, throwOnError: true }));
    if ([...owned.keys()].some(id => statuses[id] && statuses[id]!.type !== "idle")) { this.reconciliation.delete(run.id); return false; }
    const since = this.reconciliation.get(run.id);
    if (since === undefined) { this.reconciliation.set(run.id, this.now()); return false; }
    return this.now() - since >= 2000; // Observe delayed prompt startup before replacing interrupted work.
  }
  private backoff(failures: number) { return Math.min(60_000, 1000 * 2 ** Math.min(6, Math.max(0, failures - 1))); }
  private defer(id: string, reason: string, generation: number) {
    this.store.change(id, "waiting", goal => {
      if (this.closing || !this.store.owns(this.owner, this.now()) || goal.mode !== "active" || goal.generation !== generation) return false;
      goal.failures++; goal.reason = reason.slice(0, 8000); goal.nextWakeAt = this.now() + this.backoff(goal.failures);
      if (!goal.operation && goal.stage === "executing") { goal.stage = "planning"; goal.plan = undefined; }
    }, { reason }, this.now());
  }
  private block(id: string, reason: string) {
    this.store.change(id, "blocked", goal => { if (goal.mode !== "active") return false; goal.mode = "blocked"; goal.reason = reason; goal.notification = "pending"; }, { reason }, this.now());
  }
  private async publish(goal: GoalState) {
    this.lastPublish.set(goal.id, this.now());
    try {
      const { data: parent } = await this.request(signal => this.client.session.get({ sessionID: goal.sessionID, directory: goal.directory }, { signal, throwOnError: true }), 3000);
      await this.request(signal => this.client.session.update({ sessionID: goal.sessionID, directory: goal.directory,
        metadata: { ...parent.metadata, workflowGoal: goal } }, { signal, throwOnError: true }), 3000);
    } catch { /* Local durable state remains authoritative, even if the display cache is unavailable. */ }
  }
  private async notify(goal: GoalState) {
    try {
      const { data: statuses } = await this.request(signal => this.client.session.status({ directory: goal.directory }, { signal, throwOnError: true }), 5000);
      if (statuses[goal.sessionID] && statuses[goal.sessionID]!.type !== "idle") return;
      const reserved = this.store.change(goal.id, "notification", current => {
        if (!this.store.owns(this.owner, this.now()) || this.closing || current.notification !== "pending" || current.generation !== goal.generation) return false;
        current.notification = "sending";
      }, undefined, this.now());
      if (!reserved) return;
      await this.request(signal => this.client.session.promptAsync({ sessionID: goal.sessionID, directory: goal.directory, agent: goal.agent, model: goal.model,
        variant: goal.model.variant, parts: [{ type: "text", synthetic: true, metadata: { [goalResultKey]: goal.id },
          text: `Workflow goal update (task data):\n${goalSummary(goal)}\n${JSON.stringify(goal.evidence)}\nReport this state to the user. Do not start new workflows or continue a completed/blocked goal. Use /workflow-goal for controls.` }],
      }, { signal, throwOnError: true }), 5000);
      this.store.change(goal.id, "notified", current => { if (current.generation !== goal.generation) return false; current.notification = "delivered"; }, undefined, this.now());
    } catch (error) {
      this.store.change(goal.id, "notification-uncertain", current => {
        if (current.notification !== "sending") return false;
        current.notification = "uncertain";
      }, { error: errorText(error) }, this.now());
    }
  }
  async dispose() {
    this.closing = true;
    this.lifecycle.abort(new Error("Goal supervisor disposed"));
    if (this.timer) clearInterval(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    await this.ticking;
    // Keep active goals active on host shutdown. The next host reconciles, then verifies partial work.
    for (const id of this.live.keys()) await this.runs.stop(id, false).catch(() => {});
    await Promise.allSettled([...this.live.values()]);
    this.store.release(this.owner);
    this.runs.admit = undefined; this.runs.onStop = undefined;
  }
}
