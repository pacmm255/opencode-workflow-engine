import type { TuiCommand, TuiDialogSelectOption, TuiPluginApi } from "@opencode-ai/plugin/tui";
import { GoalStore } from "../core/goal/store";
import { goalSummary, terminalGoal, type GoalState } from "../core/goal/state";

export function registerGoalControls(api: TuiPluginApi, input: {
  local: boolean; perform(action: () => void | Promise<void>): Promise<void>;
  remoteRequest(title: string, request: string): void;
}) {
  const stores = new Map<string, GoalStore>();
  let disposed = false;
  const store = () => {
    const directory = api.state.path.directory;
    let value = stores.get(directory);
    if (!value) { value = new GoalStore(directory); stores.set(directory, value); }
    return value;
  };
  const get = (sessionID: string): GoalState | undefined => {
    if (disposed) return;
    if (input.local) return store().current(sessionID);
    const data = api.state.session.get(sessionID)?.metadata?.workflowGoal as GoalState | undefined;
    return data?.version === 1 && data.sessionID === sessionID && typeof data.objective === "string"
      && Array.isArray(data.criteria) && Array.isArray(data.evidence) && typeof data.mode === "string" && data.usage ? data : undefined;
  };
  const currentSession = () => api.route.current.name === "session" ? api.route.current.params?.sessionID as string | undefined : undefined;
  function details(title: string, message: string) { api.ui.dialog.replace(() => api.ui.DialogAlert({ title, message })); }
  function draftObjective() {
    api.ui.dialog.replace(() => api.ui.DialogPrompt({ title: "New workflow goal", placeholder: "Objective and acceptance requirements",
      onConfirm: value => { void input.perform(async () => {
        if (!value.trim()) throw new Error("Enter the goal objective");
        await api.client.tui.appendPrompt({ directory: api.state.path.directory, text: `/workflow-goal ${value.trim()}` }, { throwOnError: true });
        api.ui.dialog.clear();
      }); },
    }));
  }
  function history(goal: GoalState, before?: number) {
    if (!input.local) { input.remoteRequest("Remote goal history", "Use workflow_goal with action history."); return; }
    const events = store().history(goal.id, before);
    api.ui.dialog.replace(() => api.ui.DialogSelect<string>({ title: "Workflow goal history", options: [
      ...events.map(event => ({ title: `${event.sequence} · ${event.kind}`, description: new Date(event.at).toISOString(), value: String(event.sequence) })),
      { title: "Older events", value: "older", disabled: events.length < 20 },
      { title: "Back", value: "back" },
    ], onSelect: entry => input.perform(async () => {
      if (entry.value === "back") return menu();
      if (entry.value === "older") { history(goal, events.at(-1)?.sequence); return; }
      const event = events.find(event => String(event.sequence) === entry.value);
      if (event) details(event.kind, JSON.stringify(event.data, null, 2));
    }) }));
    api.ui.dialog.setSize?.("large");
  }
  async function menu() {
    const sessionID = currentSession();
    if (sessionID && api.state.session.get(sessionID)?.parentID) { details("Workflow goal", "Return to the parent session to manage its goal."); return; }
    const goal = sessionID ? get(sessionID) : undefined;
    const entries: TuiDialogSelectOption<string>[] = goal ? [
      { title: "Objective and current progress", value: "status", description: goal.objective.slice(0, 100) },
      { title: `Acceptance checks (${goal.evidence.filter(item => item.met).length}/${goal.criteria.length})`, value: "criteria" },
      { title: "History and evidence", value: "history" },
      ...(terminalGoal(goal) ? [{ title: "Start a new goal", value: "new" }] : [
        { title: "Pause goal", value: "pause", disabled: goal.mode !== "active" },
        { title: "Resume goal", value: "resume", disabled: goal.mode === "active" },
        { title: "Edit objective", value: "edit" },
        { title: "Stop goal permanently", value: "stop" },
      ]),
      { title: "Refresh", value: "refresh" },
      { title: "Done", value: "done" },
    ] : [{ title: "Start a workflow goal", value: "new", description: "Prepare an objective in your prompt, then submit to start" }, { title: "Done", value: "done" }];
    api.ui.dialog.replace(() => api.ui.DialogSelect<string>({ title: `Workflow goal — ${goal?.mode ?? "none"}${goal?.operation && goal.mode !== "active" ? " (stopping)" : ""}`, options: entries,
      onSelect: entry => input.perform(async () => {
        if (entry.disabled) return;
        const action = entry.value;
        if (action === "done") { api.ui.dialog.clear(); return; }
        if (action === "new") { draftObjective(); return; }
        if (action === "refresh") return menu();
        if (!goal) return;
        if (action === "status") { details("Workflow goal", `${goalSummary(goal)}\n\nReported usage: ${goal.usage.input} input / ${goal.usage.output + goal.usage.reasoning} output + reasoning tokens · $${goal.usage.cost}\nNo goal-wide budget or cycle/time ceiling.\n${goal.operation ? `Current run: ${goal.operation.runID}` : "No current run"}`); return; }
        if (action === "criteria") { details("Goal acceptance checks", goal.criteria.map(criterion => {
          const evidence = goal.evidence.find(item => item.criterion === criterion);
          return `${evidence?.met ? "✓" : "○"} ${criterion}${evidence ? `\n${evidence.method}: ${evidence.observation}\n${evidence.artifact}` : ""}`;
        }).join("\n\n") || "Acceptance criteria are being defined."); return; }
        if (action === "history") { history(goal); return; }
        if (!input.local) { input.remoteRequest("Remote workflow goal", `Use workflow_goal with action ${action}${action === "edit" ? " after asking me for the revised objective" : ""}.`); return; }
        if (action === "edit") {
          api.ui.dialog.replace(() => api.ui.DialogPrompt({ title: "Revise workflow goal", value: goal.objective,
            onConfirm: value => { void input.perform(async () => { store().control(goal.id, "edit", value); await menu(); }); },
          }));
          return;
        }
        if (action === "stop") {
          api.ui.dialog.replace(() => api.ui.DialogConfirm({ title: "Stop this goal permanently?", message: "Owned work is cancelled. History is retained; this goal cannot be resumed.",
            onConfirm: () => { void input.perform(async () => { store().control(goal.id, "stop"); await menu(); }); },
          }));
          return;
        }
        if (action === "pause" || action === "resume") { store().control(goal.id, action); await menu(); }
      }),
    }));
    api.ui.dialog.setSize?.("large");
  }
  return {
    // Singular belongs to the server so inline arguments are never swallowed by a native callback.
    commands: [{ title: "View and control workflow goal", value: "workflow.goals", category: "Workflow", slash: { name: "workflow-goals", aliases: ["workflow_goals"] }, onSelect: () => input.perform(menu) }] satisfies TuiCommand[],
    get, open: () => { void input.perform(menu); },
    dispose: () => { disposed = true; for (const value of stores.values()) value.close(); stores.clear(); },
  };
}
