import { tool, type Plugin } from "@opencode-ai/plugin";
import { createOpencodeClient, type Agent, type Config } from "@opencode-ai/sdk/v2";
import { ensureAuthoringSkill } from "./core/authoring-skill";
import { commands } from "./core/commands";
import { configPatchSchema, defaultConfig, loadConfig, resetConfig, saveConfig } from "./core/config";
import { failure } from "./core/errors";
import { catalogFromProviders, modelDescription, type ModelEntry, type ModelSelection } from "./core/models";
import { reference } from "./core/reference";
import { SavedWorkflows } from "./core/saved";
import { RunManager } from "./core/run/manager";
import { report } from "./core/run/report";

const WorkflowPlugin: Plugin = async ({ client: original, directory, serverUrl }) => {
  const transport = (original as unknown as { _client: { getConfig(): Parameters<typeof createOpencodeClient>[0] } })._client.getConfig();
  const client = createOpencodeClient({ baseUrl: transport?.baseUrl ?? serverUrl.toString(), fetch: transport?.fetch, headers: transport?.headers, directory });
  const manager = new RunManager(client, directory);
  await manager.recover();
  const saved = new SavedWorkflows(directory);
  let config = await loadConfig(directory).catch(() => structuredClone(defaultConfig));
  let catalog: ModelEntry[] = [];
  let agents: Agent[] = [];
  let refreshing: Promise<void> | undefined;
  let refreshed = 0;
  let disposed = false;
  const refresh = () => {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const [current, providers, available] = await Promise.all([
        loadConfig(directory),
        client.config.providers({ directory }, { throwOnError: true, signal: AbortSignal.timeout(15_000) }),
        client.app.agents({ directory }, { throwOnError: true, signal: AbortSignal.timeout(15_000) }),
      ]);
      config = current; catalog = catalogFromProviders(providers.data); agents = available.data; refreshed = Date.now();
    })().finally(() => { refreshing = undefined; });
    return refreshing;
  };
  const scope = tool.schema.enum(["project", "global"]).optional();
  return {
    config: async (current) => {
      current.command ??= {};
      for (const [name, definition] of Object.entries(commands)) current.command[name] ??= definition;
      current.agent ??= {};
      current.agent["workflow-agent"] ??= { mode: "subagent", hidden: true, description: "Return a focused result to an orchestrating workflow",
        prompt: "Complete your assigned task within its scope. Your final response is returned as data to the workflow. Be concise, cite concrete evidence when reviewing, and state limitations. Do not ask the user questions or launch further agents. Do not invoke workflow tools. Respect existing project instructions and permissions." };
      // The hook is typed with SDK v1; OpenCode 1.18 consumes v2 skill config.
      const currentV2 = current as unknown as Config;
      currentV2.skills ??= {};
      const path = await ensureAuthoringSkill();
      currentV2.skills.paths = [...new Set([...(currentV2.skills.paths ?? []), path])];
    },
    "tool.definition": async ({ toolID }, output) => {
      if (toolID !== "workflow") return;
      try { output.description = `${output.description}\n${modelDescription(config, catalog)}`; } catch { /* Never fail an assistant step while listing tools. */ }
      if (!disposed && Date.now() - refreshed > 30_000) void refresh().catch(() => {});
    },
    "chat.message": async (_input, output) => {
      for (const part of output.parts) if (part.type === "text" && /^\/workflow(?:\s|$)/.test(part.text.trim())) {
        part.text = commands.workflow.template.replace("$ARGUMENTS", part.text.trim().replace(/^\/workflow\s*/, ""));
      }
    },
    tool: {
      workflow: tool({
        description: "Execute plain JavaScript orchestration with agent, parallel, pipeline, phases and replay cache. Read workflow_reference first. Foreground blocks until finished; background survives this tool step and reports when the parent is idle. Exactly one script source is required.",
        args: { script: tool.schema.string().max(1_000_000).optional(), scriptPath: tool.schema.string().optional(), name: tool.schema.string().optional(),
          args: tool.schema.unknown().optional(), resumeFromRunId: tool.schema.string().optional(), background: tool.schema.boolean().optional(),
          description: tool.schema.string().max(200).optional(), tokenBudget: tool.schema.number().int().nonnegative().optional() },
        async execute(input, ctx) {
          await refresh();
          const [message, parent] = await Promise.all([
            client.session.message({ sessionID: ctx.sessionID, messageID: ctx.messageID, directory }, { signal: AbortSignal.timeout(15_000) }),
            client.session.get({ sessionID: ctx.sessionID, directory }, { throwOnError: true, signal: AbortSignal.timeout(15_000) }),
          ]);
          const info = message.data?.info;
          const model: ModelSelection | undefined = info?.role === "assistant" ? { providerID: info.providerID, modelID: info.modelID, variant: info.variant }
            : info?.role === "user" ? { ...info.model }
            : parent.data.model ? { providerID: parent.data.model.providerID, modelID: parent.data.model.id, variant: parent.data.model.variant } : undefined;
          if (!model) throw failure("ModelUnavailableError", "Cannot determine invoking session model");
          if (model.variant === "default") delete model.variant;
          const run = await manager.start(input, { sessionID: ctx.sessionID, agent: ctx.agent, model, config, catalog, agents,
            abort: input.background ? undefined : ctx.abort,
            metadata: (state) => ctx.metadata({ title: state.name, metadata: { workflow: state } }) });
          ctx.metadata({ title: run.state.name, metadata: { runId: run.state.id, background: run.state.background } });
          if (input.background) return `Workflow launched in background. Run ID: ${run.state.id}\nScript: ${run.state.scriptPath}\nYou will receive its result when this session is idle. Continue independent work; do not duplicate it or sleep/poll to occupy a turn. Use /workflows to view progress or stop it.`;
          return report(await run.done);
        },
      }),
      workflow_reference: tool({ description: "Read the complete workflow scripting API and reliability guidance", args: {},
        async execute() { return `${reference}\n${modelDescription(config, catalog)}`; } }),
      workflow_runs: tool({ description: "List/status/stop workflow runs, or skip one agent", args: {
        action: tool.schema.enum(["list", "status", "stop", "skip"]), runId: tool.schema.string().optional(), agentId: tool.schema.string().optional(),
      }, async execute(input, ctx) {
        if (input.action === "list") return JSON.stringify((await manager.list(ctx.sessionID)).map(({ id, name, status, agents, usage }) => ({ id, name, status, agents: agents.length, usage })), null, 2);
        const id = input.runId ?? (await manager.list(ctx.sessionID)).find((run) => input.action === "status" || run.status === "running")?.id;
        if (!id) throw failure("RunNotFoundError", "No matching run in this session");
        if (input.action === "status") return report(await manager.get(id));
        if (input.action === "stop") { await manager.stop(id); return `Stop requested: ${id}`; }
        if (!input.agentId) throw failure("WorkflowInputError", "agentId is required for skip");
        await manager.skip(id, input.agentId); return `Skip requested: ${id}/${input.agentId}`;
      } }),
      workflow_saved: tool({ description: "List/show/save/delete reusable JavaScript workflows. Delete archives the script for recovery.", args: {
        action: tool.schema.enum(["list", "show", "save", "delete"]), name: tool.schema.string().optional(), script: tool.schema.string().optional(), scope,
      }, async execute(input) {
        if (input.action === "list") return JSON.stringify(await saved.list(), null, 2);
        if (!input.name) throw failure("WorkflowInputError", "name is required");
        if (input.action === "show") return saved.load({ name: input.name });
        if (input.action === "delete") return `Archived script to ${await saved.delete(input.name, input.scope)}; recover it by moving it back.`;
        if (input.script === undefined) throw failure("WorkflowInputError", "script is required for save");
        return `Saved ${await saved.save(input.name, input.script, input.scope)}`;
      } }),
      workflow_config: tool({ description: "Show configured models from OpenCode, or set/reset workflow policy and limits", args: {
        action: tool.schema.enum(["show", "set", "reset"]), config: configPatchSchema.optional(), scope,
      }, async execute(input) {
        // Reset must remain available when the selected config is malformed or
        // the provider endpoint is unavailable. The cached catalog is sufficient.
        if (input.action === "reset") config = await resetConfig(directory, input.scope);
        else await refresh();
        if (input.action === "set") {
          if (!input.config) throw failure("WorkflowInputError", "config patch is required");
          const refs = [...(input.config.models?.allowed ?? []), ...Object.values(input.config.models?.aliases ?? {}),
            ...(input.config.models?.default && input.config.models.default !== "session" ? [input.config.models.default] : [])];
          for (const id of refs) if (!catalog.some((model) => model.id === id)) throw failure("ModelUnavailableError", `Not a connected provider/model ID: ${id}. Use workflow_config show for valid IDs.`);
          config = await saveConfig(directory, input.config, input.scope);
        }
        return JSON.stringify({ config, models: catalog, guidance: modelDescription(config, catalog) }, null, 2);
      } }),
    },
    dispose: async () => { disposed = true; await manager.dispose(); },
  };
};

export default { id: "opencode-workflow-engine", server: WorkflowPlugin };
