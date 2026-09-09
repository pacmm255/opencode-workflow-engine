import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { defaultConfig } from "../src/core/config";
import { GoalManager } from "../src/core/goal/manager";
import { GoalStore } from "../src/core/goal/store";
import { workspaceFingerprint } from "../src/core/goal/fingerprint";
import type { GoalState } from "../src/core/goal/state";
import { RunManager, type RunContext, type WorkflowInput } from "../src/core/run/manager";
import { emptyUsage, type RunState } from "../src/core/run/state";

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
const criterion = "The requested result exists and its checks pass";
const contract = { criteria: [criterion], summary: "Verify the requested result" };
const verification = (met: boolean, artifact = "proof.txt") => ({ summary: met ? "All checks passed" : "More work is needed", blocker: "",
  evidence: [{ criterion, met, method: "Read current validation evidence", observation: met ? "PASS" : "FAIL", artifact }] });
const plan = { summary: "Implement the remaining requirement", tasks: [{ id: "fix", label: "Implement", task: "Complete the missing requirement", reason: "Configured model for focused work", model: "test/model", dependsOn: [] }] };

async function fixture(options: { real?: boolean; cycles?: number; result?: (goal: GoalState, calls: number) => unknown; fingerprint?: () => Promise<string> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "workflow-goal-test-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "proof.txt"), "PASS");
  const store = new GoalStore(directory, join(directory, "goal-data"));
  cleanup.push(() => store.close());
  const requests: Array<{ path: string; body?: any }> = [];
  const parent = { id: "ses_goal", directory, metadata: {} as Record<string, unknown>, agent: "build" };
  let busy = false;
  const client = createOpencodeClient({ baseUrl: "http://goal.test", fetch: (async (request: Request) => {
    const path = new URL(request.url).pathname;
    const body = request.method === "GET" ? undefined : await request.json();
    requests.push({ path, body });
    if (path.endsWith("/children")) return Response.json([]);
    if (path === "/session/status") return Response.json(busy ? { [parent.id]: { type: "busy" } } : {});
    if (path === `/session/${parent.id}`) { if (body?.metadata) parent.metadata = body.metadata; return Response.json(parent); }
    if (path.endsWith("/prompt_async") || path.endsWith("/abort") || path === "/tui/show-toast") return Response.json(true);
    throw new Error(`Unexpected goal API request ${path}`);
  }) as typeof fetch });
  const context: RunContext = { sessionID: parent.id, agent: "build", model: { providerID: "test", modelID: "model" },
    config: structuredClone(defaultConfig), catalog: [{ id: "test/model", providerID: "test", modelID: "model", name: "Test", providerName: "Test", toolcall: true, variants: ["high", "xhigh"] }],
    agents: [{ name: "workflow-agent", mode: "subagent", permission: [], options: {} }],
  };
  context.config.ui.toasts = false;
  const calls: Array<{ input: WorkflowInput; context: RunContext }> = [];
  const records = new Map<string, RunState>();
  const output = (goal: GoalState) => options.result ? options.result(goal, calls.length)
    : goal.stage === "defining" ? contract : goal.stage === "verifying" ? verification(goal.cycle >= (options.cycles ?? 2))
    : goal.stage === "planning" ? { decision: "workflow", summary: "Finish remaining work", reason: "Missing acceptance evidence", plan }
    : { fix: "Implementation finished" };
  const fake = {
    root: join(directory, "runs"), admit: undefined as RunManager["admit"], onStop: undefined as RunManager["onStop"],
    async list() { return [...records.values()]; },
    async get(id: string) { const row = records.get(id); if (!row) throw Object.assign(new Error("Missing run"), { code: "ENOENT" }); return structuredClone(row); },
    async stop(id: string, user = true) { const row = records.get(id); if (row?.status === "running") { if (user) fake.onStop?.(row); row.status = "aborted"; row.error = user ? "User stopped the workflow" : "Goal supervisor interrupted the workflow"; } },
    async start(input: WorkflowInput, context: RunContext) {
      fake.admit?.(context); context.guard?.();
      calls.push({ input, context });
      const goal = store.get(context.goal!.id)!;
      const value = output(goal);
      const row: RunState = { id: context.goal!.operation.runID, name: "Goal operation", status: "completed", sessionID: context.sessionID,
        directory, runDir: join(directory, "runs", context.goal!.operation.runID), scriptPath: "script.js", startedAt: Date.now(), ownerPID: process.pid, background: true,
        phases: [], agents: [], logs: [], warnings: [], usage: { input: 1, output: 2, reasoning: 3, cost: 0.01 }, result: value, launchAgent: context.agent, launchModel: context.model, goal: context.goal };
      records.set(row.id, row);
      return { state: row, done: Promise.resolve(structuredClone(row)) };
    },
    async dispose() {},
  };
  const runs = options.real ? new RunManager(client, directory, fake.root, async input => {
    const goal = store.current(parent.id)!;
    await input.onSession?.(`ses_child_${goal.operation!.id}`, directory);
    return { status: "completed", value: output(goal), usage: emptyUsage(), attempts: 1 };
  }) : fake as unknown as RunManager;
  cleanup.push(() => runs.dispose());
  let now = Date.now();
  const managerOptions = { intervalMs: 0, now: () => now, fingerprint: options.fingerprint ?? (async () => "unchanged-workspace"), context: async () => context };
  const manager = new GoalManager(client, runs, store, managerOptions);
  cleanup.push(() => manager.dispose());
  const start = (objective = "Implement and verify the requested result") => manager.start({ sessionID: parent.id, agent: "build", model: context.model, objective });
  async function until(check: (goal: GoalState) => boolean, limit = 20_000) {
    for (let i = 0; i < limit; i++) {
      await manager.tick();
      await new Promise<void>(resolve => setTimeout(resolve, options.real ? 10 : 0));
      const goal = store.current(parent.id)!;
      if (check(goal)) return goal;
    }
    throw new Error(`Goal did not reach expected state: ${JSON.stringify(store.current(parent.id))}`);
  }
  return { directory, store, client, manager, runs, fake, calls, records, requests, context, parent, start, until, managerOptions,
    advance: (ms: number) => { now += ms; }, setBusy: (value: boolean) => { busy = value; } };
}

test("goal runs two fresh workflows, independently verifies, then stops without a third", async () => {
  const f = await fixture(); f.start();
  const final = await f.until(goal => goal.mode === "completed");
  expect(final.cycle).toBe(2);
  expect(final.criteria).toEqual([criterion]);
  expect(final.verifiedAt).toBeNumber();
  expect(final.fingerprint).toBe("unchanged-workspace");
  expect(f.calls.filter(call => call.input.plan)).toHaveLength(2);
  expect(f.calls.map(call => call.context.goal?.operation.stage)).toEqual(["defining", "verifying", "planning", "executing", "verifying", "planning", "executing", "verifying"]);
  expect(f.calls.every(call => call.input.tokenBudget === undefined && call.input.resumeFromRunId === undefined)).toBe(true);
  expect(new Set(f.calls.map(call => call.context.goal?.operation.runID)).size).toBe(f.calls.length);
  expect(final.usage.output).toBe(16);
  expect(f.requests.filter(request => request.path.endsWith("/prompt_async"))).toHaveLength(1);
  for (let i = 0; i < 10; i++) await f.manager.tick();
  expect(f.calls).toHaveLength(8);
});

test("an already satisfied objective completes after fresh verification without unnecessary workflows", async () => {
  const f = await fixture({ cycles: 0 }); f.start();
  const final = await f.until(goal => goal.mode === "completed");
  expect(final.cycle).toBe(0);
  expect(f.calls.map(call => call.context.goal?.operation.stage)).toEqual(["defining", "verifying"]);
});

test("crosses 1200 workflow cycles and simulated multi-day duration without an aggregate ceiling", async () => {
  const f = await fixture({ cycles: 1200 }); f.start();
  const final = await f.until(goal => {
    if (goal.cycle % 100 === 0) f.advance(86_400_000);
    return goal.mode === "completed";
  });
  expect(final.cycle).toBe(1200);
  expect(f.calls.filter(call => call.input.plan)).toHaveLength(1200);
  expect(final.updatedAt - final.createdAt).toBeGreaterThan(86_400_000);
  expect(f.store.history(final.id)).toHaveLength(20);
  const page = f.store.history(final.id);
  expect(f.store.history(final.id, page.at(-1)!.sequence)[0]!.sequence).toBeLessThan(page.at(-1)!.sequence);
}, 120_000);

test("transactions enforce one goal per session and one project owner across database connections", async () => {
  const f = await fixture(); const goal = f.start();
  const other = new GoalStore(f.directory, f.store.root); cleanup.push(() => other.close());
  expect(() => other.create({ sessionID: goal.sessionID, objective: "Another goal", agent: "build", model: goal.model })).toThrow("already has a goal");
  expect(f.store.claim("first", 1, 100)).toBe(true);
  expect(other.claim("second", 2, 100)).toBe(false);
  expect(other.claim("second", 102, 100)).toBe(true);
  expect(f.store.owns("first", 103)).toBe(false);
  other.control(goal.id, "pause");
  expect(f.store.get(goal.id)?.mode).toBe("paused");
  other.control(goal.id, "stop");
  expect(() => other.control(goal.id, "resume")).toThrow("ended");
});

test("duplicate wakeups and competing supervisors reserve just one operation", async () => {
  const f = await fixture(); f.start();
  const other = new GoalManager(f.client, f.runs, f.store, f.managerOptions); cleanup.push(() => other.dispose());
  await Promise.all(Array.from({ length: 25 }, () => f.manager.tick()).concat(other.tick()));
  expect(f.calls).toHaveLength(1);
});

test("pause fences a late verifier; resume verifies afresh, and edit cannot accept old criteria", async () => {
  const f = await fixture({ cycles: 0 }); const initial = f.start();
  await f.until(goal => goal.operation?.stage === "verifying");
  f.manager.control(initial.id, "pause");
  await f.manager.tick();
  expect(f.store.get(initial.id)?.mode).toBe("paused");
  expect(f.store.get(initial.id)?.verifiedAt).toBeUndefined();
  f.manager.control(initial.id, "resume");
  const final = await f.until(goal => goal.mode === "completed");
  expect(f.calls.filter(call => call.context.goal?.operation.stage === "verifying")).toHaveLength(2);
  expect(final.generation).toBe(3);
});

test("stop never reactivates a goal, even when completed results arrive later", async () => {
  const f = await fixture({ cycles: 0 }); const goal = f.start();
  await f.until(goal => goal.operation?.stage === "verifying");
  f.manager.control(goal.id, "stop");
  await f.manager.tick(); await f.manager.tick();
  expect(f.store.get(goal.id)?.mode).toBe("cancelled");
  expect(f.calls).toHaveLength(2);
  expect(f.requests.filter(request => request.path.endsWith("/prompt_async"))).toHaveLength(0);
});

test("changed inputs and nonexistent evidence cannot satisfy acceptance", async () => {
  let fingerprint = 0;
  const f = await fixture({ cycles: 0, fingerprint: async () => String(fingerprint++) }); f.start();
  const goal = await f.until(goal => goal.stage === "planning");
  expect(goal.mode).toBe("active"); expect(goal.evidence).toEqual([]);
  expect(goal.reason).toContain("changed");
  f.manager.control(goal.id, "stop");
  const g = await fixture({ result: goal => goal.stage === "defining" ? contract : verification(true, "missing-proof.txt") }); g.start();
  const unmet = await g.until(goal => goal.stage === "planning");
  expect(unmet.mode).toBe("active"); expect(unmet.evidence[0]?.met).toBe(false);
});

test("missing and duplicate criteria, null output, failed and skipped children never close a goal", async () => {
  const f = await fixture({ result: goal => goal.stage === "defining" ? contract : { ...verification(true), evidence: [verification(true).evidence[0], verification(true).evidence[0]] } }); f.start();
  const goal = await f.until(goal => goal.stage === "planning");
  expect(goal.mode).toBe("active"); expect(goal.evidence).toEqual([]);
  f.manager.control(goal.id, "stop");
  for (const status of ["failed", "skipped"] as const) {
    const g = await fixture({ cycles: 0 }); g.start();
    const before = await g.until(goal => goal.operation?.stage === "verifying");
    g.records.get(before.operation!.runID)!.agents.push({ id: "a_1", sequence: 1, label: "Check", model: "test/model", status, usage: emptyUsage() });
    await g.manager.tick();
    expect(g.store.current(g.parent.id)?.mode).toBe("active");
    expect(g.store.current(g.parent.id)?.verifiedAt).toBeUndefined();
    g.manager.control(before.id, "stop");
  }
});

test("per-run timeout replans, while explicit stop pauses the supervisor", async () => {
  const f = await fixture(); const goal = f.start();
  const running = await f.until(goal => goal.operation?.stage === "executing");
  const row = f.records.get(running.operation!.runID)!;
  row.status = "timeout"; row.error = "Run timed out";
  await f.manager.tick();
  expect(f.store.get(goal.id)?.mode).toBe("active");
  expect(f.store.get(goal.id)?.stage).toBe("planning");
  f.advance(60_000);
  const second = await f.until(goal => goal.operation?.stage === "executing");
  const secondRow = f.records.get(second.operation!.runID)!;
  secondRow.status = "running";
  await f.runs.stop(secondRow.id);
  expect(f.store.get(goal.id)?.mode).toBe("paused");
});

test("a denied operation blocks rather than retrying under a different model", async () => {
  const f = await fixture(); f.start();
  const goal = await f.until(goal => goal.operation?.stage === "executing");
  const run = f.records.get(goal.operation!.runID)!;
  run.status = "failed"; run.error = "Permission denied by the user";
  await f.manager.tick();
  expect(f.store.get(goal.id)?.mode).toBe("blocked");
  const count = f.calls.length;
  f.advance(5 * 86_400_000);
  await f.manager.tick();
  expect(f.calls).toHaveLength(count);
});

test("selected models are revalidated; unavailable pool cannot silently switch provider", async () => {
  const f = await fixture(); f.context.config.models.allowed = ["missing/model"]; f.start();
  await f.manager.tick();
  expect(f.calls).toHaveLength(0);
  expect(f.store.current(f.parent.id)?.mode).toBe("active");
  expect(f.store.current(f.parent.id)?.reason).toContain("model");
  f.context.config.models.allowed = ["test/model"]; f.advance(60_000);
  await f.manager.tick();
  expect(f.calls).toHaveLength(1);
});

test("Ultracode exact effort applies to goal orchestration without changing the session setting", async () => {
  const f = await fixture(); f.context.ultracode = { messageID: "msg", source: "session", task: "Work", effort: "xhigh" }; f.start();
  await f.manager.tick();
  expect(f.calls[0]?.context.model.variant).toBe("xhigh");
  expect(f.calls[0]?.input.script).toContain('"variant":"xhigh"');
  expect(() => f.runs.admit?.(f.context)).toThrow("goal owns");
});

test("busy parents do not acquire a second worker, and pending reservation recovery is safe", async () => {
  const f = await fixture(); const goal = f.start(); f.setBusy(true);
  await f.manager.tick(); expect(f.calls).toHaveLength(0);
  f.setBusy(false);
  await f.manager.tick();
  const pending = f.store.get(goal.id)!;
  f.records.delete(pending.operation!.runID);
  await f.manager.tick();
  expect(f.store.get(goal.id)?.mode).toBe("active");
  expect(f.calls.length).toBeLessThanOrEqual(2);
});

test("restart reconciles the reserved identity, retains usage, and resumes active but not paused goals", async () => {
  const f = await fixture(); const goal = f.start();
  const before = await f.until(goal => goal.operation?.stage === "executing");
  await f.manager.dispose();
  const reopened = new GoalStore(f.directory, f.store.root); cleanup.push(() => reopened.close());
  const next = new GoalManager(f.client, f.runs, reopened, f.managerOptions); cleanup.push(() => next.dispose());
  await next.tick();
  expect(reopened.get(goal.id)?.operation?.runID).toBe(before.operation?.runID);
  f.advance(3000);
  await next.tick();
  expect(reopened.get(goal.id)?.usage.output).toBeGreaterThanOrEqual(before.usage.output);
  expect(f.calls.filter(call => call.context.goal?.operation.runID === before.operation?.runID)).toHaveLength(1);
  next.control(goal.id, "pause");
  await next.tick();
  const count = f.calls.length;
  f.advance(86_400_000); await next.tick();
  expect(reopened.get(goal.id)?.mode).toBe("paused");
  expect(f.calls).toHaveLength(count);
});

test("objective edits fence already produced verifier results and discard the prior checklist", async () => {
  const f = await fixture({ cycles: 0 }); const original = f.start();
  await f.until(goal => goal.operation?.stage === "verifying");
  f.manager.control(original.id, "edit", "A different explicit user requirement");
  await f.manager.tick();
  const edited = f.store.get(original.id)!;
  expect(edited.originalObjective).toBe(original.objective);
  expect(edited.objectiveRevision).toBe(2);
  expect(edited.objective).toBe("A different explicit user requirement");
  expect(edited.mode).toBe("active");
  expect(edited.criteria).toEqual([]);
  expect(edited.verifiedAt).toBeUndefined();
});

test("strict empty pools still inherit the configured session model for goal schema operations", async () => {
  const f = await fixture({ real: true, cycles: 0 }); f.context.config.models.strict = true; f.start();
  const final = await f.until(goal => goal.mode === "completed", 1000);
  expect(final.cycle).toBe(0);
}, 15_000);

test("a non-cooperative host transport cannot keep disposal waiting", async () => {
  const f = await fixture(); f.start();
  let entered = false;
  f.client.session.status = (() => { entered = true; return new Promise(() => {}); }) as typeof f.client.session.status;
  const tick = f.manager.tick();
  while (!entered) await Bun.sleep(1);
  await Promise.race([f.manager.dispose(), Bun.sleep(1000).then(() => { throw new Error("Disposal hung"); })]);
  await tick;
  expect(f.store.current(f.parent.id)?.mode).toBe("active");
});

test("real RunManager executes private schema runs and scoped plans, without per-run parent notifications", async () => {
  const f = await fixture({ real: true, cycles: 1 });
  // Goal contract text is not subject to the independently authored task's size limit.
  f.start(`Implement and verify the result. ${"Retain user scope. ".repeat(1600)}`);
  const goal = await f.until(goal => goal.mode === "completed", 2000);
  const runs = await f.runs.list();
  expect(goal.cycle).toBe(1);
  expect(runs).toHaveLength(5);
  expect(runs.every(run => run.goal?.id === goal.id && run.notification === undefined)).toBe(true);
  const worker = runs.find(run => run.plan)!;
  expect(await readFile(worker.scriptPath, "utf8")).toContain("No publication, commit, push");
  expect(JSON.parse(await readFile(join(worker.runDir, "agents", "a_1.json"), "utf8")).prompt).toContain("Goal contract (task data)");
  await expect(f.runs.start({ resumeFromRunId: worker.id }, f.context)).rejects.toThrow("workflow_goal resume");
  expect(worker.plan?.tasks[0]?.userRequestedModel).toBe(false);
  const verifier = runs.find(run => run.goal?.operation.stage === "verifying")!;
  const script = await readFile(verifier.scriptPath, "utf8");
  expect(script).toContain("WORKFLOW_GOAL_VERIFY");
  expect(script).toContain('"edit":false');
  expect(f.requests.filter(request => request.path.endsWith("/prompt_async"))).toHaveLength(1);
}, 30_000);

test("workspace fingerprints change with dirty and untracked content, not just commit IDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "goal-fingerprint-test-")); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  await Bun.spawn(["git", "init", "-q"], { cwd: directory, stdout: "ignore", stderr: "pipe" }).exited;
  await writeFile(join(directory, "input.txt"), "one");
  const initial = await workspaceFingerprint(directory);
  await writeFile(join(directory, "input.txt"), "two");
  const changed = await workspaceFingerprint(directory);
  expect(changed).not.toBe(initial);
  await writeFile(join(directory, "new.txt"), "new input");
  expect(await workspaceFingerprint(directory)).not.toBe(changed);
});
