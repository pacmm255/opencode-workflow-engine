import type { TuiCommand, TuiDialogSelectOption, TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, resetConfig, saveConfig, type ConfigScope } from "./core/config.ts";
import { catalogFromProviders, type ModelEntry } from "./core/models.ts";
import { runsDirectory } from "./core/paths.ts";

const runIDPattern = /^wf_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const agentIDPattern = /^[A-Za-z0-9_-]{1,100}$/;
const active = new Set(["running", "pending", "queued", "retrying", "starting"]);

interface AgentView {
  id: string;
  label: string;
  status: string;
  model: string;
  phase?: string;
  sessionID?: string;
}
interface RunView {
  id: string;
  name: string;
  status: string;
  sessionID: string;
  directory: string;
  startedAt: number;
  phase?: string;
  agents: AgentView[];
  error?: string;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function runView(value: unknown, sessionID: string): RunView | undefined {
  if (!object(value) || typeof value.id !== "string" || !runIDPattern.test(value.id)
    || value.sessionID !== sessionID || typeof value.name !== "string" || typeof value.status !== "string"
    || typeof value.directory !== "string" || typeof value.startedAt !== "number" || !Array.isArray(value.agents)) return;
  const agents: AgentView[] = [];
  for (const item of value.agents) {
    if (!object(item) || typeof item.id !== "string" || !agentIDPattern.test(item.id)
      || typeof item.status !== "string" || typeof item.label !== "string" || typeof item.model !== "string") continue;
    agents.push({ id: item.id, status: item.status, label: item.label, model: item.model,
      ...(typeof item.phase === "string" ? { phase: item.phase } : {}),
      ...(typeof item.sessionID === "string" ? { sessionID: item.sessionID } : {}),
    });
  }
  return { id: value.id, name: value.name, status: value.status, sessionID, directory: value.directory,
    startedAt: value.startedAt, agents,
    ...(typeof value.phase === "string" ? { phase: value.phase } : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  };
}

/** A loopback URL cannot distinguish a local server from an SSH tunnel. */
function localConnection(api: TuiPluginApi): boolean {
  try {
    type Transport = { getConfig?: () => { baseUrl?: string } };
    // The generated v2 SDK exposes `client`; `_client` was only in our old mock.
    const transport = api.client as unknown as { client?: Transport; _client?: Transport };
    const baseUrl = (transport.client ?? transport._client)?.getConfig?.().baseUrl;
    if (!baseUrl) return false;
    const url = new URL(baseUrl);
    return ["http:", "https:"].includes(url.protocol)
      && ["localhost", "127.0.0.1", "[::1]", "::1", "opencode.internal"].includes(url.hostname);
  } catch { return false; }
}

async function readRun(id: string, sessionID: string): Promise<RunView> {
  if (!runIDPattern.test(id)) throw new Error("Invalid workflow run ID.");
  const root = await realpath(runsDirectory());
  const folder = join(root, id);
  if (!(await lstat(folder)).isDirectory() || await realpath(folder) !== folder) throw new Error("Invalid workflow run directory.");
  const file = join(folder, "run.json");
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error("Invalid workflow run record.");
  const run = runView(JSON.parse(await readFile(file, "utf8")), sessionID);
  if (!run || run.id !== id) throw new Error("Workflow does not belong to the current session.");
  return run;
}

async function signalRun(id: string, sessionID: string, agentID?: string): Promise<void> {
  const run = await readRun(id, sessionID);
  if (!active.has(run.status)) throw new Error("This workflow has already finished.");
  if (agentID !== undefined && (!agentIDPattern.test(agentID) || !run.agents.some((agent) => agent.id === agentID && active.has(agent.status)))) {
    throw new Error("This agent is no longer running in the selected workflow.");
  }
  const file = join(await realpath(runsDirectory()), id, agentID ? `SKIP_${agentID}` : "STOP");
  try {
    const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile("Requested from the workflow TUI.\n"); }
    finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await lstat(file)).isFile()) throw error;
  }
}

export const WorkflowTuiPlugin: TuiPlugin = async (api, options) => {
  // Explicit remote=true also covers a remote server reached through a local tunnel.
  const local = options?.remote !== true && localConnection(api);
  let scope: ConfigScope = "project";
  let disposed = false;
  let work = Promise.resolve();
  const directory = () => api.state.path.directory;
  const globalDirectory = () => api.state.path.config;
  const currentSession = () => {
    const route = api.route.current;
    return route.name === "session" && typeof route.params?.sessionID === "string" ? route.params.sessionID : undefined;
  };
  function alert(title: string, message: string) {
    if (!disposed) api.ui.dialog.replace(() => api.ui.DialogAlert({ title, message }));
  }
  function perform(action: () => void | Promise<void>): Promise<void> {
    work = work.then(async () => {
      if (disposed) return;
      try { await action(); }
      catch (error) { alert("Workflow", error instanceof Error ? error.message : String(error)); }
    });
    return work;
  }
  function select(title: string, entries: TuiDialogSelectOption<string>[], action: (value: string) => void | Promise<void>) {
    if (disposed) return;
    api.ui.dialog.replace(() => api.ui.DialogSelect<string>({
      title, options: entries, placeholder: "Search…",
      onSelect: (entry) => { if (!entry.disabled) return perform(() => action(entry.value)); },
    }));
    // replace() resets the host size, so widen only after opening the page.
    api.ui.dialog.setSize?.("large");
  }
  function remoteRequest(title: string, request: string) {
    api.ui.dialog.replace(() => api.ui.DialogAlert({
      title,
      message: "The native picker and run controls edit local files. This connection is remote or its location is unknown. Confirm to put a request for the server's workflow tools in your prompt; review and submit it there.",
      onConfirm: () => { void perform(async () => {
        await api.client.tui.appendPrompt({ directory: directory(), text: request }, { throwOnError: true });
        api.ui.dialog.clear();
      }); },
    }));
  }
  async function configuration() {
    if (!local) { remoteRequest("Workflow configuration on a remote server", "Use workflow_config with action show, then help me configure the workflow model pool."); return; }
    const config = await loadConfig(directory(), globalDirectory());
    select(`Workflow configuration (${scope})`, [
      { title: `Connected providers and model pool (${config.models.allowed.length})`, value: "models", description: "Pick a connection, then models" },
      { title: `Default model: ${config.models.default}`, value: "default" },
      { title: `Strict model pool: ${config.models.strict ? "on" : "off"}`, value: "strict", description: "Inherited default/session model remains permitted" },
      { title: `Size guideline: ${config.sizeGuideline ?? "unrestricted"}`, value: "size" },
      { title: `Save scope: ${scope}`, value: "scope", description: "Effective settings; project overrides global" },
      { title: `Reset ${scope} overrides`, value: "reset" },
      { title: "Done", value: "done" },
    ], async (value) => {
      if (value === "models") return providerPicker("pool");
      if (value === "default") return providerPicker("default");
      if (value === "scope") { scope = scope === "project" ? "global" : "project"; return configuration(); }
      if (value === "strict") {
        const latest = await loadConfig(directory(), globalDirectory());
        await saveConfig(directory(), { models: { strict: !latest.models.strict } }, scope, globalDirectory());
        return configuration();
      }
      if (value === "size") {
        api.ui.dialog.replace(() => api.ui.DialogPrompt({
          title: "Advisory workflow size (positive integer or unrestricted)", value: String(config.sizeGuideline ?? "unrestricted"),
          onConfirm: (value) => { void perform(async () => {
            const sizeGuideline = /^(unrestricted|none|off)$/i.test(value.trim()) ? null : Number(value);
            await saveConfig(directory(), { sizeGuideline }, scope, globalDirectory());
            await configuration();
          }); },
          onCancel: () => { void perform(configuration); },
        }));
        return;
      }
      if (value === "reset") {
        api.ui.dialog.replace(() => api.ui.DialogConfirm({
          title: `Reset ${scope} workflow overrides?`, message: "Inherited settings will take effect.",
          onConfirm: () => { void perform(async () => { await resetConfig(directory(), scope, globalDirectory()); await configuration(); }); },
          onCancel: () => { void perform(configuration); },
        }));
        return;
      }
      api.ui.dialog.clear();
    });
  }
  function connectedCatalog(): ModelEntry[] {
    // This live snapshot is the same config.providers() data used by /models,
    // not the full unauthenticated provider catalog or a hard-coded model list.
    return catalogFromProviders(api.state.provider.map((provider) => ({
      ...provider,
      models: Object.fromEntries(Object.entries(provider.models ?? {})
        .filter(([, model]) => model.status !== "deprecated")
        .map(([id, model]) => [id, { ...model, capabilities: {
          ...model.capabilities, toolcall: model.capabilities?.toolcall === true,
        } }])),
    })));
  }
  type PickerMode = "pool" | "default";
  async function providerPicker(mode: PickerMode) {
    const config = await loadConfig(directory(), globalDirectory());
    const catalog = connectedCatalog();
    const stale = config.models.allowed.filter(id => !catalog.some(entry => entry.id === id));
    if (!catalog.length && !(mode === "pool" && stale.length)) {
      alert("No connected workflow models", "Use OpenCode's /connect to connect a provider, then /models to check its available models. Reopen /workflow-config to refresh the list.");
      return;
    }
    const providers = new Map<string, ModelEntry[]>();
    for (const entry of catalog) providers.set(entry.providerID, [...(providers.get(entry.providerID) ?? []), entry]);
    const entries: TuiDialogSelectOption<string>[] = [...providers].map(([id, models]) => ({
      title: models[0]!.providerName, value: `provider:${id}`, category: "Connected providers",
      description: `${models.length} models · ${models.filter(model => config.models.allowed.includes(model.id)).length} selected`,
      footer: id,
    }));
    if (catalog.length) entries.push({ title: "All connected models", value: "__all", category: "Browse" });
    if (mode === "pool" && stale.length) entries.push({ title: "Unavailable selected models", value: "__unavailable", category: "Manage", description: `${stale.length} selected models can be removed` });
    if (mode === "default") entries.push({ title: "Same model as the invoking session", value: "session", category: "Inheritance" });
    entries.push({ title: "Back", value: "__back", category: "Settings" });
    select(`Connected providers — ${mode === "pool" ? "model pool" : "default model"}`, entries, async (value) => {
      if (value === "__back") return configuration();
      if (value === "session" && mode === "default") {
        await saveConfig(directory(), { models: { default: "session" } }, scope, globalDirectory());
        return configuration();
      }
      const providerID = value.startsWith("provider:") ? value.slice("provider:".length) : undefined;
      await modelPicker(mode, providerID, value === "__unavailable");
    });
  }
  async function modelPicker(mode: PickerMode, providerID?: string, unavailable = false) {
    const config = await loadConfig(directory(), globalDirectory());
    const catalog = connectedCatalog();
    const models = unavailable ? [] : catalog.filter(entry => providerID === undefined || entry.providerID === providerID);
    const entries: TuiDialogSelectOption<string>[] = models.map((entry) => ({
      title: `${mode === "pool" ? config.models.allowed.includes(entry.id) ? "[x] " : "[ ] " : config.models.default === entry.id ? "[x] " : ""}${entry.name}`,
      value: entry.id, description: entry.id, category: entry.providerName,
      disabled: !entry.toolcall && !(mode === "pool" && config.models.allowed.includes(entry.id)),
      footer: entry.toolcall ? entry.variants.join(", ") : "No tool calls; unavailable for workflow selection",
    }));
    if (mode === "pool" && (unavailable || providerID === undefined)) {
      for (const id of config.models.allowed.filter(id => !catalog.some(entry => entry.id === id))) {
        entries.push({ title: `[x] ${id}`, value: id, category: "Unavailable models", description: "Select to remove the stale model" });
      }
    }
    entries.push({ title: "Back to providers", value: "__back", category: "Settings" });
    const name = unavailable ? "Unavailable models" : providerID === undefined ? "All connected models" : models[0]?.providerName ?? providerID;
    select(`${name} — ${mode === "pool" ? "workflow model pool" : "default workflow model"}`, entries, async (id) => {
      if (id === "__back") return providerPicker(mode);
      const latest = await loadConfig(directory(), globalDirectory());
      if (mode === "pool" && latest.models.allowed.includes(id)) {
        await saveConfig(directory(), { models: { allowed: latest.models.allowed.filter(value => value !== id) } }, scope, globalDirectory());
      } else {
        const selected = connectedCatalog().find(entry => entry.id === id);
        if (!selected?.toolcall) throw new Error("This model is no longer available for workflows. Reopen /workflow-config to refresh OpenCode's connections.");
        await saveConfig(directory(), { models: mode === "pool" ? { allowed: [...latest.models.allowed, id] } : { default: id } }, scope, globalDirectory());
      }
      if (mode === "default") return configuration();
      await modelPicker(mode, providerID, unavailable);
    });
  }

  async function workflows() {
    const sessionID = currentSession();
    if (!sessionID) { alert("Workflows", "Open a session to view its workflows."); return; }
    const values = new Map<string, RunView>();
    if (local) {
      const files = await readdir(runsDirectory()).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const id of files.filter((id) => runIDPattern.test(id))) {
        try { const run = await readRun(id, sessionID); values.set(id, run); }
        catch { /* Other sessions, removed records, and malformed records are not selectable. */ }
      }
    }
    const latest = runView(api.state.session.get(sessionID)?.metadata?.workflow, sessionID);
    if (latest) values.set(latest.id, latest);
    const runs = [...values.values()].sort((a, b) => b.startedAt - a.startedAt);
    if (!runs.length) { alert("Workflows", local ? "No workflows found for this session." : "No workflow metadata is available for this remote session. Ask the server's workflow_runs tool to list saved runs."); return; }
    select(local ? "Session workflows" : "Remote session workflows", runs.map((run) => ({
      title: `${run.name} — ${run.status}`, value: run.id, description: `${run.id}${run.phase ? ` · ${run.phase}` : ""}`, footer: `${run.agents.length} agents`,
    })), (id) => { const run = values.get(id); if (run) runDetails(run); });
  }
  function runDetails(run: RunView) {
    select(`${run.name} — ${run.status}`, [
      ...run.agents.map((agent) => ({ title: `${agent.label} — ${agent.status}`, value: agent.id, category: agent.phase ?? "Agents", description: agent.model })),
      { title: "Stop workflow", value: "__stop", category: "Manage", disabled: !active.has(run.status) },
      { title: "Refresh workflows", value: "__back", category: "Manage" },
      ...(run.error ? [{ title: "Show error", value: "__error", category: "Manage" }] : []),
    ], async (value) => {
      if (value === "__back") return workflows();
      if (value === "__error") { alert(run.name, run.error!); return; }
      if (value === "__stop") {
        if (!local) { remoteRequest("Stop a remote workflow", `Use workflow_runs with action stop and runId ${run.id}.`); return; }
        await signalRun(run.id, run.sessionID);
        api.ui.toast({ variant: "info", message: `Stop requested for ${run.name}.` });
        api.ui.dialog.clear();
        return;
      }
      const agent = run.agents.find((agent) => agent.id === value);
      if (agent) agentDetails(run, agent);
    });
  }
  function agentDetails(run: RunView, agent: AgentView) {
    select(`${agent.label} — ${agent.status}`, [
      { title: "Open child session", value: "open", disabled: !agent.sessionID },
      { title: "Skip this agent", value: "skip", disabled: !active.has(agent.status) || !active.has(run.status) },
      { title: "Back to workflow", value: "back" },
    ], async (value) => {
      if (value === "back") { runDetails(run); return; }
      if (value === "open" && agent.sessionID) {
        api.ui.dialog.clear();
        api.route.navigate("session", { sessionID: agent.sessionID });
        return;
      }
      if (value === "skip") {
        if (!local) { remoteRequest("Skip a remote workflow agent", `Use workflow_runs with action skip, runId ${run.id}, and agentId ${agent.id}.`); return; }
        await signalRun(run.id, run.sessionID, agent.id);
        api.ui.toast({ variant: "info", message: `Skip requested for ${agent.label}.` });
        runDetails(run);
      }
    });
  }

  const commands: TuiCommand[] = [
    { title: "Configure workflow models", value: "workflow.config", category: "Workflow", slash: { name: "workflow-config", aliases: ["workflow_config"] }, onSelect: () => perform(configuration) },
    { title: "View session workflows", value: "workflow.runs", category: "Workflow", slash: { name: "workflows" }, onSelect: () => perform(workflows) },
  ];
  // This shape mirrors OpenCode 1.18's own command compatibility bridge.
  const unregister = typeof api.keymap?.registerLayer === "function" ? api.keymap.registerLayer({
    commands: commands.map((command) => ({ namespace: "palette", name: command.value, title: command.title,
      category: command.category, slashName: command.slash?.name, slashAliases: command.slash?.aliases, run: () => command.onSelect?.(),
    })),
  }) : api.command?.register(() => commands);
  if (!unregister) api.ui.toast({ variant: "warning", message: "Native workflow commands are unavailable; use the server workflow tools." });
  api.lifecycle.onDispose(() => { disposed = true; unregister?.(); });
};

export default { id: "opencode-workflow-engine-tui", tui: WorkflowTuiPlugin } satisfies TuiPluginModule;
