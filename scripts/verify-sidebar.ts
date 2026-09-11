import assert from "node:assert/strict";
import { testRender } from "@opentui/solid";
import { isServer } from "solid-js/web";
import type { TuiPluginApi, TuiSlotPlugin } from "@opencode-ai/plugin/tui";
import { registerWorkflowSidebar } from "../src/tui-sidebar";
import type { RunView } from "../src/tui/sidebar-state";
import type { GoalState } from "../src/core/goal/state";

/**
 * Real OpenTUI renderer, using deterministic state; no model or user config.
 * Run `bun run test:sidebar`. Direct invocation also re-enters with the same
 * browser Solid runtime that OpenCode supplies to TUI plugins; the default
 * Node/server Solid export intentionally implements createEffect as a no-op.
 */
if (isServer) {
  const child = Bun.spawn([process.execPath, "--conditions=browser", "run", import.meta.path], {
    cwd: process.cwd(), env: process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  process.exit(await child.exited);
}
let slot!: NonNullable<TuiSlotPlugin["slots"]["sidebar_content"]>;
let metadata: RunView | undefined;
let goal: GoalState | undefined;
let opens = 0;
const disposals: Array<() => void> = [];
const api = {
  theme: { current: { text: "#eeeeee", textMuted: "#aaaaaa", primary: "#77ccff", success: "#77ddaa", error: "#ff8888", warning: "#eecc66" } },
  slots: { register: (plugin: TuiSlotPlugin) => { slot = plugin.slots.sidebar_content!; return "workflow.sidebar"; } },
  lifecycle: { onDispose: (dispose: () => void) => { disposals.push(dispose); return () => {}; } },
} as unknown as TuiPluginApi;
registerWorkflowSidebar(api, { source: () => ({ metadata: () => metadata }), goal: () => goal,
  open: () => { opens++; }, showAll: () => { opens++; }, openGoal: () => { opens++; } });
const screen = await testRender(() => slot({ theme: api.theme }, { session_id: "session" }) as never, { width: 42, height: 35 });
async function waitFor(text: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await screen.renderOnce();
    const frame = screen.captureCharFrame();
    if (frame.includes(text)) return frame;
    await Bun.sleep(100);
  }
  throw new Error(`Sidebar did not render ${text}:\n${screen.captureCharFrame()}`);
}
try {
  await screen.renderOnce();
  assert(!screen.captureCharFrame().includes("Workflows"));
  metadata = {
    id: "wf_demo", sessionID: "session", directory: "/isolated", name: "Review implementation", status: "running", startedAt: 1,
    phase: "Inspect", agents: [{ id: "a_1", taskId: "review", label: "Reviewer", model: "demo/reviewer", agentType: "reviewer", status: "running",
      selectionReason: "Independent correctness review" }],
    plan: { summary: "Review, then verify", tasks: [
      { id: "review", label: "Reviewer", model: "demo/reviewer", reason: "Independent correctness review", dependsOn: [] },
      { id: "verify", label: "Verifier", model: "demo/verifier", reason: "Run targeted checks", dependsOn: ["review"] },
    ] },
  };
  const running = await waitFor("Reviewer · running");
  assert(running.includes("demo/reviewer"));
  assert(running.includes("Verifier · queued"));
  assert(running.includes("0/2 agents finished"));
  metadata = { ...metadata, phase: "Verification", agents: [
    { ...metadata.agents[0]!, status: "completed" },
    { id: "a_2", taskId: "verify", label: "Verifier", model: "demo/verifier", status: "running" },
  ] };
  const verifying = await waitFor("Verifier · running");
  assert(verifying.includes("Verification"));
  assert(verifying.includes("1/2 agents finished"));
  metadata = { ...metadata, status: "completed", agents: metadata.agents.map(agent => ({ ...agent, status: "completed" })) };
  const completed = await waitFor("2/2 agents finished");
  assert(completed.includes("✓ completed"));
  assert(!completed.includes("running"));
  goal = {
    version: 1, id: "goal_demo", directory: "/isolated", sessionID: "session", originalObjective: "Implement and verify the feature",
    objective: "Implement and verify the feature", objectiveRevision: 1, generation: 1, mode: "active", stage: "planning",
    createdAt: 1, updatedAt: 1, agent: "build", model: { providerID: "test", modelID: "coordinator" },
    coordinator: { providerID: "test", modelID: "coordinator", variant: "max" }, criteria: ["Feature works", "Tests pass"],
    cycle: 2, summary: "Waiting for provider quota reset", nextWakeAt: Date.parse("2026-09-11T14:00:00.000Z"), failures: 1,
    evidence: [], usage: { input: 100, output: 20, reasoning: 10, cost: 0 },
    waiting: { kind: "quota", since: 1, until: Date.parse("2026-09-11T14:00:00.000Z") },
  };
  const waiting = await waitFor("active · quota · planning");
  assert(waiting.includes("0/2 checks · 2 workflow attempts"));
  assert(waiting.includes("Retry after 2026-09-11T14:00:00.000Z"));
  assert(waiting.includes("Supervisor: test/coordinator · max"));
  goal = { ...goal, waiting: { kind: "supervisor offline", since: 1 } };
  const offline = await waitFor("supervisor offline");
  assert(!offline.includes("Retry after"));
  assert.equal(opens, 0, "Rendering must not open dialogs or submit commands");
  console.log("✓ Real terminal sidebar renders tasks, completion, coordinator model, quota retry time, and offline ownership without opening dialogs.");
} finally {
  disposals.forEach(dispose => dispose());
  screen.renderer.destroy();
}
