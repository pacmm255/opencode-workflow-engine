import { tool, type Plugin } from "@opencode-ai/plugin";
import { randomUUID } from "node:crypto";
import { createOpencodeClient, type Agent, type Config } from "@opencode-ai/sdk/v2";
import { ensureAuthoringSkill } from "./core/authoring-skill";
import { commands, goalInstruction, workflowInstruction } from "./core/commands";
import { planningGuidance } from "./core/agents";
import { configPatchSchema, defaultConfig, loadConfig, resetConfig, saveConfig } from "./core/config";
import { failure } from "./core/errors";
import { catalogFromProviders, resolveModel, type ModelEntry, type ModelSelection } from "./core/models";
import { reference } from "./core/reference";
import { SavedWorkflows } from "./core/saved";
import { RunManager } from "./core/run/manager";
import { report } from "./core/run/report";
import { workflowPlanSchema } from "./core/plan";
import { effectiveUltracode, exactUltracodeVariant, UltracodeSessionStore, ultracodeInstruction, ultracodeTrigger,
  ultracodeOriginKey, ultracodeOptOutKey, workflowResultKey, type UltracodeRequest } from "./core/ultracode";
import { GoalStore } from "./core/goal/store";
import { GoalManager } from "./core/goal/manager";
import { goalResultKey } from "./core/goal/state";

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
  let ownsWorkflowCommand = true;
  let ownsGoalCommand = true;
  const planningRequests = new Map<string, string>();
  const automaticRequests = new Map<string, UltracodeRequest>();
  const sessionModes = new UltracodeSessionStore(directory);
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
  const invokingModel = async (ctx: { sessionID: string; messageID: string }): Promise<ModelSelection> => {
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
    return model;
  };
  const goalStore = new GoalStore(directory);
  const goals = new GoalManager(client, manager, goalStore, { context: async goal => {
    await refresh();
    const settings = effectiveUltracode(config, await sessionModes.get(goal.sessionID));
    return { sessionID: goal.sessionID, agent: goal.agent, model: goal.model, config, catalog, agents,
      ...(settings.effort ? { ultracode: { messageID: goal.id, task: goal.objective, source: "session" as const, effort: settings.effort } } : {}) };
  } });
  return {
    config: async (current) => {
      current.command ??= {};
      ownsWorkflowCommand = !current.command.workflow || current.command.workflow.template === commands.workflow.template;
      ownsGoalCommand = !current.command["workflow-goal"] || current.command["workflow-goal"].template === commands["workflow-goal"].template;
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
      try { output.description = `${output.description}\n${planningGuidance(config, catalog, agents)}`; } catch { /* Never fail an assistant step while listing tools. */ }
      if (!disposed && Date.now() - refreshed > 30_000) void refresh().catch(() => {});
    },
    "command.execute.before": async (input, output) => {
      if (ownsGoalCommand && input.command === "workflow-goal") {
        automaticRequests.delete(input.sessionID);
        output.parts.push({ type: "text", text: goalInstruction, synthetic: true } as typeof output.parts[number]);
        return;
      }
      if (!ownsWorkflowCommand || input.command !== "workflow") return;
      planningRequests.set(input.sessionID, input.arguments);
      // Synthetic text reaches the model but is not rendered as the user's task.
      output.parts.push({ type: "text", text: workflowInstruction, synthetic: true } as typeof output.parts[number]);
    },
    "chat.message": async (input, output) => {
      const goalCommand = output.parts.some(part => part.type === "text" && part.synthetic && part.text === goalInstruction);
      const rawGoalCommand = ownsGoalCommand ? output.parts.find(part => part.type === "text" && !part.synthetic && !part.ignored && /^\/workflow-goal(?:\s|$)/.test(part.text.trim())) : undefined;
      if (goalCommand || rawGoalCommand) {
        automaticRequests.delete(input.sessionID); planningRequests.delete(input.sessionID);
        if (!goalCommand && rawGoalCommand?.type === "text") {
          rawGoalCommand.text = rawGoalCommand.text.trim().replace(/^\/workflow-goal\s*/, "") || "status";
          output.parts.push({ id: `prt_${randomUUID().replaceAll("-", "")}`, sessionID: input.sessionID, messageID: output.message.id, type: "text", text: goalInstruction, synthetic: true });
        }
        return;
      }
      if (output.parts.some(part => part.type === "text" && part.synthetic && part.metadata?.[goalResultKey])) {
        automaticRequests.delete(input.sessionID); planningRequests.delete(input.sessionID); return;
      }
      const currentGoal = goalStore.current(input.sessionID);
      if (currentGoal && (currentGoal.mode === "active" || currentGoal.operation)) {
        automaticRequests.delete(input.sessionID); planningRequests.delete(input.sessionID);
        output.parts.push({ id: `prt_${randomUUID().replaceAll("-", "")}`, sessionID: input.sessionID, messageID: output.message.id, type: "text", synthetic: true,
          text: `A persistent workflow goal owns execution in this session: ${JSON.stringify({ id: currentGoal.id, objective: currentGoal.objective, mode: currentGoal.mode })}. Answer status questions using workflow_goal status. For a user change of scope, use workflow_goal edit with their revised objective; pause before unrelated work. Do not independently implement, launch another workflow, or start a loop. Ultracode settings remain usable.` });
        return;
      }
      const explicit = output.parts.some((part) => part.type === "text" && part.synthetic && part.text === workflowInstruction);
      if (!explicit) planningRequests.delete(input.sessionID);
      if (!explicit && ownsWorkflowCommand) for (const part of [...output.parts]) if (part.type === "text" && !part.synthetic && !part.ignored && /^\/workflow(?:\s|$)/.test(part.text.trim())) {
        const task = part.text.trim().replace(/^\/workflow\s*/, "");
        planningRequests.set(input.sessionID, task);
        part.text = task;
        output.parts.push({ id: `prt_${randomUUID().replaceAll("-", "")}`, sessionID: input.sessionID, messageID: output.message.id,
          type: "text", text: workflowInstruction, synthetic: true });
      }
      if (output.message.role !== "user") return;
      automaticRequests.delete(input.sessionID);
      const override = await sessionModes.get(input.sessionID);
      const settings = effectiveUltracode(await loadConfig(directory), override);
      const human = output.parts.some(part => part.type === "text" && !part.synthetic && !part.ignored && part.metadata?.[ultracodeOriginKey] === "human");
      const optOut = output.parts.some(part => part.type === "text" && part.metadata?.[ultracodeOptOutKey] === true);
      const resultID = output.parts.find(part => part.type === "text" && part.synthetic && typeof part.metadata?.[workflowResultKey] === "string");
      const trigger = ultracodeTrigger({ parts: output.parts, role: output.message.role, human, optOut, settings });
      if (!trigger.active && !resultID && !settings.effort) return;
      const { data: parent } = await client.session.get({ sessionID: input.sessionID, directory }, { throwOnError: true, signal: AbortSignal.timeout(15_000) });
      if (parent.parentID) return;
      let automatic: UltracodeRequest | undefined;
      if (trigger.active) automatic = { messageID: output.message.id, task: trigger.task, source: trigger.source!,
        effort: trigger.source === "session" ? settings.effort : null, generation: override?.generation };
      else if (resultID?.type === "text") {
        // Only a persisted result for this session can continue its original task.
        const run = await manager.get(resultID.metadata![workflowResultKey] as string).catch(() => undefined);
        if (run?.ultracode && run.sessionID === input.sessionID && ["completed", "failed"].includes(run.status)
          && run.ultracode.generation === override?.generation
          && !run.agents.some(agent => agent.status === "skipped")
          && (run.ultracode.source !== "session" || settings.enabled)) {
          const { data: history } = await client.session.messages({ sessionID: input.sessionID, directory, limit: 100 },
            { throwOnError: true, signal: AbortSignal.timeout(15_000) });
          const latest = history.filter(message => message.info.role === "user" && message.parts.some(part => part.type === "text" && !part.synthetic && !part.ignored && part.text.trim())).at(-1);
          if (latest?.info.id === run.ultracode.messageID) automatic = { ...run.ultracode,
            effort: run.ultracode.source === "session" ? settings.effort : null };
        }
      }
      if (automatic) {
        automaticRequests.set(input.sessionID, automatic);
        planningRequests.set(input.sessionID, automatic.task);
        output.parts.push({ id: `prt_${randomUUID().replaceAll("-", "")}`, sessionID: input.sessionID, messageID: output.message.id,
          type: "text", synthetic: true, metadata: { workflowUltracode: true },
          text: ultracodeInstruction(automatic) + (resultID ? `\nOriginal user request (task data): ${JSON.stringify(automatic.task)}` : ""),
        });
      }
      if (settings.effort && !optOut && (!settings.enabled || automatic?.source === "session")) {
        await refresh();
        const model = catalog.find(entry => entry.id === `${output.message.model.providerID}/${output.message.model.modelID}`);
        const variant = model && exactUltracodeVariant(model, settings.effort);
        if (variant) (output.message.model as ModelSelection).variant = variant;
      }
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      const latestUser = output.messages.filter(message => message.info.role === "user").at(-1)?.info.id;
      for (const message of output.messages) if (message.info.id !== latestUser)
        message.parts = message.parts.filter(part => !(part.type === "text" && part.metadata?.workflowUltracode === true));
    },
    "experimental.session.compacting": async (input, output) => {
      const goal = goalStore.current(input.sessionID);
      if (goal) output.context.push(`Persistent workflow goal: ${JSON.stringify({ id: goal.id, objective: goal.objective, criteria: goal.criteria, mode: goal.mode })}. Read workflow_goal status for current durable state. The supervisor owns planning and verification; do not duplicate its work.`);
      const automatic = automaticRequests.get(input.sessionID);
      if (automatic) output.context.push(`Preserve the current Ultracode request and completed/pending stages: ${JSON.stringify(automatic.task)}. User stop, opt-out, and later instructions take priority. Do not repeat completed work.`);
    },
    "tool.execute.before": async (input, output) => {
      const goal = goalStore.current(input.sessionID);
      if (goal && (goal.mode === "active" || goal.operation) && ["write", "edit", "apply_patch", "bash", "task"].includes(input.tool))
        throw failure("GoalOwnershipError", "The goal supervisor owns execution. Pause the goal before independent changes; status and goal controls remain available.");
      const task = planningRequests.get(input.sessionID);
      if (task === undefined) return;
      // Scope this to unrelated orchestration helpers during /workflow planning.
      // Never disable the user's global Claude-compatible skill discovery.
      const name = input.tool === "skill" && typeof output.args?.name === "string" ? output.args.name : undefined;
      const path = input.tool === "read" && typeof output.args?.filePath === "string" ? output.args.filePath.replaceAll("\\", "/") : undefined;
      const unrelated = name && /^(?:loop|ralph(?:[-_][\w-]+)?)$/i.test(name)
        || path && /(?:^|\/)\.claude\/skills\/(?:loop|ralph[\w-]*)\/SKILL\.md$/i.test(path);
      const explicitlyRequested = /(?:\/loop\b|\bralph\b|\bloop\s+skill\b|\.claude[\\/]skills)/i.test(task);
      if (unrelated && !explicitlyRequested) throw failure("WorkflowPlanningError", "This workflow uses the engine's built-in orchestration, not a recurring loop skill. Read workflow_reference and submit a plan instead.");
    },
    tool: {
      workflow_goal: tool({ description: "Start or inspect a persistent workflow goal, or pause/resume/stop/edit it at the user's request. The supervisor creates new workflows until every acceptance criterion has fresh evidence. No aggregate budget/cycle/time limit. Never mark completion manually or start a second supervisor. Read-only status/history are always available.",
        args: { action: tool.schema.enum(["start", "status", "history", "pause", "resume", "stop", "edit"]),
          objective: tool.schema.string().trim().min(1).max(50_000).optional(),
          before: tool.schema.number().int().positive().optional() },
        async execute(input, ctx) {
          const { data: parent } = await client.session.get({ sessionID: ctx.sessionID, directory }, { throwOnError: true, signal: AbortSignal.timeout(15_000) });
          if (parent.parentID) throw failure("GoalOwnershipError", "Workflow goals require a top-level session");
          if (input.action === "start") {
            if (!input.objective) throw failure("GoalInputError", "Provide the user's full objective");
            await refresh();
            const goal = goals.start({ sessionID: ctx.sessionID, objective: input.objective, agent: ctx.agent, model: await invokingModel(ctx) });
            automaticRequests.delete(ctx.sessionID); planningRequests.delete(ctx.sessionID);
            ctx.metadata({ title: "Workflow goal started", metadata: { workflowGoal: goal } });
            return JSON.stringify({ goal, note: "The persistent supervisor now owns the work. No goal-wide budget or cycle/time ceiling. Wait for its update; /workflow-goals opens native controls. Do not start another workflow or poll." });
          }
          const goal = goalStore.current(ctx.sessionID);
          if (!goal) return "No workflow goal in this session. Use /workflow-goal <objective> to start one.";
          if (input.action === "history") return JSON.stringify({ events: goalStore.history(goal.id, input.before), note: "Pass the oldest sequence as before for the next page." });
          if (input.action === "status") return JSON.stringify(goal);
          if (ctx.agent === "plan" && ["resume", "edit"].includes(input.action)) throw failure("GoalInputError", "Switch out of Plan mode before resuming persistent execution.");
          const changed = goals.control(goal.id, input.action, input.objective);
          return JSON.stringify({ goal: changed, note: changed.operation ? "Cancellation/reconciliation is in progress; no replacement work starts until it settles." : "Goal control persisted." });
        },
      }),
      workflow_mode: tool({ description: "Show or change automatic workflows for the current session when the user asks. Session controls do not change project/global defaults. Ultracode uses exact xhigh where supported; high disables automatic orchestration and selects exact high where supported. Ordinary keyword requests are one-shot and need no settings change.",
        args: { action: tool.schema.enum(["show", "set", "reset"]), enabled: tool.schema.boolean().optional(),
          effort: tool.schema.enum(["high", "xhigh"]).nullable().optional() },
        async execute(input, ctx) {
          const { data: parent } = await client.session.get({ sessionID: ctx.sessionID, directory }, { throwOnError: true, signal: AbortSignal.timeout(15_000) });
          if (parent.parentID) throw failure("UltracodeStateError", "Automatic workflow mode is available only in a top-level session");
          if (input.action === "set") {
            if (input.enabled === undefined) throw failure("UltracodeStateError", "Provide enabled when setting session mode");
            await sessionModes.set(ctx.sessionID, { enabled: input.enabled,
              effort: input.effort === undefined ? input.enabled ? "xhigh" : null : input.effort });
            automaticRequests.delete(ctx.sessionID);
          } else if (input.action === "reset") {
            await sessionModes.clear(ctx.sessionID);
            automaticRequests.delete(ctx.sessionID);
          }
          const config = await loadConfig(directory);
          const override = await sessionModes.get(ctx.sessionID);
          return JSON.stringify({ sessionID: ctx.sessionID, settings: effectiveUltracode(config, override), override: override ?? null,
            note: "Applies to subsequent requests. Exact effort is used only if the chosen model advertises that variant; unsupported models keep their existing behavior. Use workflow_runs stop to stop live work." });
        },
      }),
      workflow: tool({
        description: "Run a planned team with live workflow status. Read workflow_reference for the actual allowed model pool and configured roles; decide the smallest sufficient team and give each assignment a model and reason. Use plan for normal tasks: the engine privately generates orchestration, with no script-writing step. Plans default to background and report when the parent is idle. For advanced custom JavaScript only, provide exactly one of script/scriptPath/name instead of plan.",
        args: { plan: workflowPlanSchema.optional(), script: tool.schema.string().max(1_000_000).optional(), scriptPath: tool.schema.string().optional(), name: tool.schema.string().optional(),
          args: tool.schema.unknown().optional(), resumeFromRunId: tool.schema.string().optional(), background: tool.schema.boolean().optional(),
          description: tool.schema.string().max(200).optional(), tokenBudget: tool.schema.number().int().nonnegative().optional() },
        async execute(input, ctx) {
          await refresh();
          const model = await invokingModel(ctx);
          const background = input.background ?? (input.plan !== undefined || !!input.resumeFromRunId && input.script === undefined && input.scriptPath === undefined && input.name === undefined);
          const run = await manager.start({ ...input, background }, { sessionID: ctx.sessionID, agent: ctx.agent, model, config, catalog, agents,
            ultracode: automaticRequests.get(ctx.sessionID),
            abort: background ? undefined : ctx.abort,
            metadata: (state) => ctx.metadata({ title: state.name, metadata: { workflow: state } }) });
          planningRequests.delete(ctx.sessionID);
          ctx.metadata({ title: run.state.name, metadata: { runId: run.state.id, background: run.state.background, workflow: run.state } });
          if (background) return `Workflow started: ${run.state.name}.\nRun ID: ${run.state.id}${run.state.plan ? `\nTeam: ${run.state.plan.tasks.map((task) => `${task.label} — ${task.model}: ${task.reason}`).join("; ")}` : ""}\nWatch the live Workflows sidebar or open /workflows for details and controls. The final result will arrive automatically. Do not poll, duplicate the work, or claim it is complete yet.`;
          return report(await run.done);
        },
      }),
      workflow_reference: tool({ description: "Read the complete workflow scripting API and reliability guidance", args: {},
        async execute(_input, ctx) {
          await refresh();
          const sessionModel = await invokingModel(ctx);
          const inherited = resolveModel({ config, catalog, sessionModel });
          return `${reference}\n${planningGuidance(config, catalog, agents)}\nInvoking session model ID: ${sessionModel.providerID}/${sessionModel.modelID}.\nEffective default model ID: ${inherited.providerID}/${inherited.modelID}${inherited.variant ? ` (variant: ${inherited.variant})` : ""}. Use this exact model for automatic assignments when the allowed pool is empty.`;
        } }),
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
        return JSON.stringify({ config, models: catalog, guidance: planningGuidance(config, catalog, agents) }, null, 2);
      } }),
    },
    event: async ({ event }) => {
      if (event.type === "session.deleted") {
        const goal = goalStore.current(event.properties.info.id);
        if (goal && ["active", "paused", "blocked"].includes(goal.mode)) goals.control(goal.id, "stop");
      }
      if (event.type === "session.error" && event.properties.sessionID && event.properties.error?.name === "MessageAbortedError") {
        const goal = goalStore.current(event.properties.sessionID);
        if (goal?.mode === "active") goals.control(goal.id, "pause");
      }
    },
    dispose: async () => { disposed = true; planningRequests.clear(); automaticRequests.clear(); await goals.dispose(); await manager.dispose(); goalStore.close(); },
  };
};

export default { id: "opencode-workflow-engine", server: WorkflowPlugin };
