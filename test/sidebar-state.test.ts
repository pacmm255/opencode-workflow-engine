import { afterEach, expect, test } from "bun:test";
import { createSidebarTracker, mergeRunViews, plannedAgents, sidebarAgents, sidebarRuns, sidebarText, type RunView, type SidebarSnapshot } from "../src/tui/sidebar-state";

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach(dispose => dispose()));
const run = (patch: Partial<RunView> = {}): RunView => ({
  id: "wf_run", name: "Implementation", status: "running", sessionID: "ses_parent", directory: "/project", startedAt: 1,
  phase: "Review", agents: [{ id: "a_1", label: "Reviewer", model: "provider/reviewer", status: "running" }], ...patch,
});

test("sidebar prioritizes active runs and active agents, retaining latest terminal result", () => {
  const completed = run({ id: "old", status: "completed", startedAt: 3 });
  const running = run();
  expect(sidebarRuns(mergeRunViews([completed, running]))).toEqual([running]);
  expect(sidebarRuns(mergeRunViews([completed, run({ status: "completed" })]))).toEqual([completed]);
  const agentRun = run({ agents: Array.from({ length: 8 }, (_, index) => ({ id: `a_${index}`, label: String(index),
    model: "provider/model", status: index === 7 ? "running" : "completed" })) });
  expect(sidebarAgents(agentRun)).toHaveLength(4);
  expect(sidebarAgents(agentRun)[0]?.id).toBe("a_7");
});

test("fresh host progress is used but delayed running metadata cannot resurrect completed disk state", () => {
  const disk = run({ status: "completed", phase: "Done" });
  expect(mergeRunViews([disk], run())[0]).toEqual(disk);
  const live = run({ phase: "Verify" });
  expect(mergeRunViews([run()], live)[0]?.phase).toBe("Verify");
});

test("planned dependencies are visible before dispatch and become blocked after a failed prerequisite", () => {
  const value = run({ agents: [], plan: { summary: "Three stages", tasks: [
    { id: "inspect", label: "Inspect", model: "provider/model", reason: "Read", dependsOn: [] },
    { id: "build", label: "Build", model: "provider/model", reason: "Implement", dependsOn: ["inspect"] },
    { id: "verify", label: "Verify", model: "provider/model", reason: "Test", dependsOn: ["build"] },
  ] } });
  expect(plannedAgents(value).map(agent => agent.status)).toEqual(["queued", "queued", "queued"]);
  value.agents = [{ id: "a_1", taskId: "inspect", label: "Inspect", model: "provider/model", status: "failed" }];
  expect(plannedAgents(value).map(agent => agent.status)).toEqual(["failed", "blocked", "blocked"]);
  value.agents = [];
  value.status = "aborted";
  expect(plannedAgents(value).every(agent => agent.status === "blocked")).toBe(true);
});

test("sidebar text cannot inject control codes and long rationale is bounded", () => {
  expect(sidebarText("a\u001bb\n\tc")).toBe("a b c");
  expect(sidebarText("a".repeat(500), 50)).toHaveLength(50);
});

test("remote sidebar updates directly from session metadata without reading local files", async () => {
  let metadata: RunView | undefined;
  const published: SidebarSnapshot[] = [];
  const tracker = createSidebarTracker({ metadata: () => metadata }, value => published.push(value), { intervalMs: 60_000 });
  cleanup.push(tracker.dispose);
  await tracker.refresh();
  metadata = run({ agents: [{ id: "a_1", label: "Reviewer", model: "provider/reviewer", status: "running",
    agentType: "reviewer", selectionReason: "Review capability matches this task" }] });
  await tracker.refresh();
  expect(published.at(-1)?.runs[0]?.agents[0]?.selectionReason).toContain("matches");
  metadata = { ...metadata, status: "completed", phase: "Verified" };
  await tracker.refresh();
  expect(published.at(-1)?.runs[0]?.status).toBe("completed");
});

test("local sidebar discovers simultaneous runs and polls completion without manual dialog refresh", async () => {
  const states = new Map(["first", "second"].map(id => [id, run({ id })]));
  const published: SidebarSnapshot[] = [];
  let discoveries = 0;
  const tracker = createSidebarTracker({ metadata: () => undefined,
    discover: async () => { discoveries++; return [...states.values()]; },
    read: async id => states.get(id)!,
  }, value => published.push(value), { intervalMs: 60_000 });
  cleanup.push(tracker.dispose);
  await tracker.refresh();
  expect(published.at(-1)?.runs).toHaveLength(2);
  states.set("first", run({ id: "first", status: "completed" }));
  states.set("second", run({ id: "second", phase: "Final verification" }));
  await tracker.refresh();
  expect(published.at(-1)?.runs.map(value => value.id)).toEqual(["second"]);
  expect(published.at(-1)?.runs[0]?.phase).toBe("Final verification");
  expect(discoveries).toBe(1);
});

test("terminal tombstones prevent stale metadata resurrecting a run while another remains active", async () => {
  const first = run({ id: "first", startedAt: 2 });
  const disk = new Map([["first", first], ["second", run({ id: "second" })]]);
  let latest!: SidebarSnapshot;
  const tracker = createSidebarTracker({ metadata: () => first, discover: async () => [...disk.values()], read: async id => disk.get(id)! },
    value => { latest = value; }, { intervalMs: 60_000 });
  cleanup.push(tracker.dispose);
  await tracker.refresh();
  disk.set("first", { ...first, status: "completed" });
  await tracker.refresh();
  expect(latest.runs.map(run => run.id)).toEqual(["second"]);
  await tracker.refresh();
  expect(latest.runs.map(run => run.id)).toEqual(["second"]);
});

test("polls are coalesced and disposal discards delayed disk results", async () => {
  let resolve!: (value: RunView[]) => void;
  let calls = 0;
  const published: SidebarSnapshot[] = [];
  const tracker = createSidebarTracker({ metadata: () => undefined,
    discover: () => { calls++; return new Promise(done => { resolve = done; }); },
  }, value => published.push(value), { intervalMs: 60_000 });
  const first = tracker.refresh();
  expect(tracker.refresh()).toBe(first);
  tracker.dispose();
  const count = published.length;
  resolve([run()]);
  await first;
  expect(calls).toBe(1);
  expect(published).toHaveLength(count);
  await tracker.refresh();
  expect(calls).toBe(1);
});

test("disk failures keep last host progress visible and recovery clears the warning", async () => {
  let fail = true;
  let latest!: SidebarSnapshot;
  const tracker = createSidebarTracker({ metadata: () => run(),
    discover: async () => { if (fail) throw new Error("offline"); return [run()]; },
  }, value => { latest = value; }, { intervalMs: 60_000 });
  cleanup.push(tracker.dispose);
  await tracker.refresh();
  expect(latest.unavailable).toBe(true);
  expect(latest.runs[0]?.status).toBe("running");
  fail = false;
  await tracker.refresh();
  expect(latest.unavailable).toBe(false);
});

test("a temporarily unavailable host state does not reject a sidebar poll", async () => {
  let latest!: SidebarSnapshot;
  const tracker = createSidebarTracker({ metadata: () => { throw new Error("host state unavailable"); } },
    value => { latest = value; }, { intervalMs: 60_000 });
  cleanup.push(tracker.dispose);
  await expect(tracker.refresh()).resolves.toBeUndefined();
  expect(latest.unavailable).toBe(true);
});
