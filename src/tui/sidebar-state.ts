export interface AgentView {
  id: string;
  label: string;
  status: string;
  model: string;
  phase?: string;
  sessionID?: string;
  agentType?: string;
  selectionReason?: string;
  taskId?: string;
}

export interface PlannedTaskView {
  id: string;
  label: string;
  reason: string;
  model: string;
  agentType?: string;
  dependsOn: string[];
}

export interface RunView {
  id: string;
  name: string;
  status: string;
  sessionID: string;
  directory: string;
  startedAt: number;
  phase?: string;
  agents: AgentView[];
  error?: string;
  plan?: { summary: string; tasks?: PlannedTaskView[] };
}

export const activeStatuses = new Set(["running", "pending", "queued", "retrying", "starting"]);
export const isActiveRun = (run: RunView) => activeStatuses.has(run.status);

/** Terminal disk state wins over a delayed running metadata event. */
export function mergeRunViews(local: RunView[], metadata?: RunView): RunView[] {
  const values = new Map(local.map(run => [run.id, run]));
  if (metadata) {
    const disk = values.get(metadata.id);
    if (!disk || isActiveRun(disk) || !isActiveRun(metadata)) values.set(metadata.id, metadata);
  }
  return [...values.values()].sort((a, b) => Number(isActiveRun(b)) - Number(isActiveRun(a)) || b.startedAt - a.startedAt);
}

export function sidebarRuns(runs: RunView[]): RunView[] {
  const running = runs.filter(isActiveRun);
  return running.length ? running : runs.slice(0, 1);
}

function retainKnownRuns(runs: RunView[], metadataID?: string): RunView[] {
  // Keep recent terminal records as tombstones: a delayed host event must not
  // resurrect a finished run merely because another workflow is still active.
  return [...runs.filter(isActiveRun), ...runs.filter(run => !isActiveRun(run)).filter((run, index) => index < 4 || run.id === metadataID)];
}

export function plannedAgents(run: RunView): AgentView[] {
  if (!run.plan?.tasks?.length) return run.agents;
  const actual = new Map(run.agents.filter(agent => agent.taskId).map(agent => [agent.taskId!, agent]));
  const tasks = new Map(run.plan.tasks.map(task => [task.id, task]));
  const blocked = new Set([...actual].filter(([, row]) => ["failed", "skipped", "blocked"].includes(row.status)).map(([id]) => id));
  const dependents = new Map<string, string[]>();
  for (const task of run.plan.tasks) for (const dependency of task.dependsOn) {
    const children = dependents.get(dependency) ?? [];
    children.push(task.id); dependents.set(dependency, children);
    if (!tasks.has(dependency)) blocked.add(task.id);
  }
  // Iterative propagation is bounded even for large or malformed cyclic data.
  const queue = [...blocked];
  for (let index = 0; index < queue.length; index++) for (const child of dependents.get(queue[index]!) ?? []) {
    if (actual.has(child) || blocked.has(child)) continue;
    blocked.add(child); queue.push(child);
  }
  return [
    ...run.plan.tasks.map(task => actual.get(task.id) ?? {
      id: task.id, taskId: task.id, label: task.label, model: task.model, agentType: task.agentType,
      selectionReason: task.reason, status: !isActiveRun(run) || blocked.has(task.id) ? "blocked" : "queued",
    }),
    ...run.agents.filter(agent => !agent.taskId || !tasks.has(agent.taskId)),
  ];
}

export function sidebarAgents(run: RunView, limit = 4): AgentView[] {
  return [...plannedAgents(run)].sort((a, b) => Number(activeStatuses.has(b.status)) - Number(activeStatuses.has(a.status))).slice(0, limit);
}

export function sidebarText(value: string, limit = 120): string {
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

export interface SidebarSource {
  metadata(): RunView | undefined;
  /** Omit local methods for a remote or unknown connection. */
  discover?: () => Promise<RunView[]>;
  read?: (id: string) => Promise<RunView>;
}

export interface SidebarSnapshot {
  runs: RunView[];
  unavailable: boolean;
}

/** One in-flight poll per mounted sidebar; no network/model calls or writes. */
export function createSidebarTracker(source: SidebarSource, publish: (state: SidebarSnapshot) => void,
  options: { intervalMs?: number; discoveryMs?: number; now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  let closed = false;
  let pending: Promise<void> | undefined;
  let nextDiscovery = 0;
  let local: RunView[] = [];
  let previous = "";
  const emit = (unavailable: boolean) => {
    if (closed) return;
    let metadata: RunView | undefined;
    try { metadata = source.metadata(); }
    catch { unavailable = true; }
    const runs = mergeRunViews(local, metadata);
    const snapshot = { runs: sidebarRuns(runs), unavailable };
    const key = JSON.stringify(snapshot);
    if (key === previous) return;
    previous = key;
    publish(snapshot);
  };
  const refresh = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (pending) return pending;
    pending = (async () => {
      let unavailable = false;
      try {
        // Publish host metadata immediately, even if disk discovery is slow.
        emit(false);
        if (source.discover && now() >= nextDiscovery) {
          const discovered = await source.discover();
          if (closed) return;
          local = retainKnownRuns(mergeRunViews(discovered), source.metadata()?.id);
          nextDiscovery = now() + (options.discoveryMs ?? 10_000);
        } else if (source.read) {
          const ids = new Set(local.filter(isActiveRun).map(run => run.id));
          const metadata = source.metadata();
          if (metadata) ids.add(metadata.id);
          const values = new Map(local.map(run => [run.id, run]));
          // Bound filesystem reads even with many simultaneously active runs.
          const queue = [...ids];
          for (let offset = 0; offset < queue.length && !closed; offset += 4) {
            await Promise.all(queue.slice(offset, offset + 4).map(async id => {
              try { values.set(id, await source.read!(id)); }
              catch { unavailable = true; }
            }));
          }
          local = retainKnownRuns(mergeRunViews([...values.values()]), metadata?.id);
        }
      } catch { unavailable = true; }
      if (!closed) emit(unavailable);
    })().finally(() => { pending = undefined; });
    return pending;
  };
  const timer = setInterval(() => { void refresh(); }, options.intervalMs ?? 1000);
  timer.unref?.();
  void refresh();
  return { refresh, dispose() { closed = true; clearInterval(timer); } };
}
