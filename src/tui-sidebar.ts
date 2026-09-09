import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { createElement, insert, setProp } from "@opentui/solid";
import { createEffect, createSignal, onCleanup, untrack, type JSX } from "solid-js";
import { activeStatuses, createSidebarTracker, isActiveRun, plannedAgents, sidebarAgents, sidebarText,
  type RunView, type SidebarSnapshot, type SidebarSource } from "./tui/sidebar-state";

type Child = string | ReturnType<typeof createElement> | (() => Child | Child[] | null);
function element(tag: string, props: Record<string, unknown>, children: Child[] = []) {
  const node = createElement(tag);
  for (const [key, value] of Object.entries(props)) if (value !== undefined) setProp(node, key, value);
  for (const child of children) insert(node, child);
  return node;
}

export interface WorkflowSidebarOptions {
  source(sessionID: string): SidebarSource;
  open(run: RunView): void;
  showAll(): void;
}

/** OpenCode owns slot unregistration; each mounted component owns its poller. */
export function registerWorkflowSidebar(api: TuiPluginApi, options: WorkflowSidebarOptions): void {
  const trackers = new Set<ReturnType<typeof createSidebarTracker>>();
  let disposed = false;
  const dispose = () => {
    disposed = true;
    for (const tracker of trackers) tracker.dispose();
    trackers.clear();
  };
  api.lifecycle.onDispose(dispose);
  api.slots.register({
    order: 120,
    dispose,
    slots: {
      sidebar_content(_context, props) {
        if (disposed) return null;
        const [state, setState] = createSignal<SidebarSnapshot>({ runs: [], unavailable: false });
        createEffect(() => {
          const sessionID = props.session_id;
          setState({ runs: [], unavailable: false });
          // The effect owns the session, not each reactive metadata snapshot.
          // Without untrack(), its initial poll would remount on every update.
          const tracker = untrack(() => createSidebarTracker(options.source(sessionID), setState));
          trackers.add(tracker);
          onCleanup(() => { tracker.dispose(); trackers.delete(tracker); });
        });
        const root = element("box", { flexDirection: "column", flexShrink: 0 });
        insert(root, () => {
          const snapshot = state();
          if (!snapshot.runs.length || disposed) return null;
          const theme = api.theme.current;
          const text = (value: string, color = theme.textMuted) => element("text", { fg: color, wrapMode: "word" }, [value]);
          const running = snapshot.runs.filter(isActiveRun).length;
          const rows = snapshot.runs.slice(0, 2).map(run => {
            const allAgents = plannedAgents(run);
            const finished = allAgents.filter(agent => ["completed", "cached"].includes(agent.status)).length;
            const color = isActiveRun(run) ? theme.primary : run.status === "completed" ? theme.success : theme.error;
            const agents = sidebarAgents(run, snapshot.runs.length > 1 ? 2 : 4);
            return element("box", { flexDirection: "column", paddingTop: 1,
              onMouseDown: () => { if (!disposed) options.open(run); } }, [
              text(sidebarText(run.name, 80), theme.text),
              text(`${isActiveRun(run) ? "●" : run.status === "completed" ? "✓" : "!"} ${run.status}${run.phase ? ` · ${sidebarText(run.phase, 60)}` : ""}`, color),
              text(`${finished}/${allAgents.length} agents finished`),
              ...(run.plan?.summary && run.plan.summary !== run.name ? [text(sidebarText(run.plan.summary, 110))] : []),
              ...agents.flatMap(agent => [
                text(`${activeStatuses.has(agent.status) ? "●" : ["completed", "cached"].includes(agent.status) ? "✓" : "!"} ${sidebarText(agent.label, 60)} · ${agent.status}`,
                  activeStatuses.has(agent.status) ? theme.text : theme.textMuted),
                text(`  ${sidebarText(agent.model, 100)}${agent.agentType ? ` · ${sidebarText(agent.agentType, 40)}` : ""}`),
                ...(agent.selectionReason ? [text(`  ${sidebarText(agent.selectionReason, 90)}`)] : []),
              ]),
              ...(allAgents.length > agents.length ? [text(`+${allAgents.length - agents.length} agents in /workflows`)] : []),
            ]);
          });
          return element("box", { flexDirection: "column" }, [
            element("text", { fg: theme.text, onMouseDown: () => { if (!disposed) options.showAll(); } },
              [`Workflows${running ? ` · ${running} running` : ""}`]),
            ...rows,
            ...(snapshot.runs.length > 2 ? [text(`+${snapshot.runs.length - 2} workflows`)] : []),
            ...(snapshot.unavailable ? [text("Progress unavailable · retrying", theme.warning)] : []),
            element("text", { fg: theme.textMuted, paddingTop: 1,
              onMouseDown: () => { if (!disposed) options.showAll(); } }, ["/workflows · inspect / stop"]),
          ]);
        });
        // SlotRegistry's public generic still references Solid's DOM JSX type;
        // OpenTUI's documented createElement() returns a terminal renderable.
        return root as unknown as JSX.Element;
      },
    },
  });
}
