import type { Agent } from "@opencode-ai/sdk/v2/types";
import type { WorkflowConfig } from "./config.ts";
import { modelDescription, type ModelEntry, type ModelSelection } from "./models.ts";

export interface AgentEntry {
  name: string;
  mode: "subagent" | "all";
  hidden: boolean;
  description?: string;
  model?: ModelSelection;
}

/** Configured candidates, not a permission grant. Hidden agents can still be subagents. */
export function catalogFromAgents(agents: Agent[]): AgentEntry[] {
  return agents.filter((agent) => agent.mode === "subagent" || agent.mode === "all")
    .map((agent): AgentEntry => ({
      name: agent.name,
      mode: agent.mode as AgentEntry["mode"],
      hidden: agent.hidden === true,
      ...(agent.description ? { description: agent.description } : {}),
      ...(agent.model ? { model: { providerID: agent.model.providerID, modelID: agent.model.modelID,
        ...(agent.variant ? { variant: agent.variant } : {}) } } : {}),
    })).sort((a, b) => a.name.localeCompare(b.name));
}

export function agentDescription(config: WorkflowConfig, catalog: ModelEntry[], agents: Agent[]): string {
  const entries = catalogFromAgents(agents);
  const models = new Map(catalog.map((entry) => [entry.id, entry]));
  const lines = [
    `Default workflow agent type: ${config.defaults.agent}.`,
    "Configured subagent candidates (from OpenCode app.agents, not an independent permission allowlist):",
  ];
  for (const entry of entries) {
    const modelID = entry.model ? `${entry.model.providerID}/${entry.model.modelID}` : undefined;
    const model = modelID ? models.get(modelID) : undefined;
    const details = [
      entry.description || "No description provided",
      `mode: ${entry.mode}`,
      modelID ? `configured model: ${modelID}${entry.model?.variant ? `; variant: ${entry.model.variant}` : ""}` : "model: inherits workflow default unless explicitly assigned",
    ];
    if (modelID && !model) details.push("WARNING: configured model is unavailable; choose an allowed explicit model or another agent");
    if (model && (!model.toolcall || model.status === "deprecated")) details.push("WARNING: configured model is not usable for autonomous workflow assignments");
    if (modelID && config.models.strict && !config.models.allowed.includes(modelID)) details.push("WARNING: configured model is outside the strict pool; an allowed explicit model override is required");
    else if (modelID && config.models.allowed.length && !config.models.allowed.includes(modelID)) details.push("configured model is outside the autonomous pool; choose an allowed explicit model unless the user requested this model");
    lines.push(`- ${entry.name}: ${details.join("; ")}.`);
  }
  if (!entries.length) lines.push("- No configured subagent candidates are currently available. Refresh configuration before launching work.");
  if (!entries.some((entry) => entry.name === config.defaults.agent)) lines.push(`WARNING: default agent ${config.defaults.agent} is not available as a subagent.`);
  lines.push("Choose agentType by its configured role and description, never by an invented type. Primary-only agents cannot be used as workflow children. Hidden means omitted from the ordinary picker, not forbidden. Selecting a candidate or model never grants permissions; existing OpenCode execution and approval rules still apply.");
  return lines.join("\n");
}

export function planningGuidance(config: WorkflowConfig, catalog: ModelEntry[], agents: Agent[]): string {
  return [
    "Workflow assignment planning:",
    "Honor explicit user choices of agent types, models, and team size within configured hard limits and permission rules; report conflicts rather than silently substituting. Strict model policy remains authoritative even for explicit requests.",
    "If the user omits the agent count, choose the smallest sufficient team from the actual work: one focused agent can be enough. Add agents only for distinct useful tasks or independent verification; do not fill the size guideline or concurrency limit as a quota.",
    "Each assignment must have a concrete task, a meaningful label, and a brief reason explaining why its agent type and model suit that task and why the additional assignment is needed. Make model choices explicit when choosing from a nonempty allowed pool. Do not merely say 'default', 'best', or 'fast'.",
    "Use dependencies for sequential work and parallelize only independent tasks. Avoid duplicate assignments and conflicting edits. A workflow plan is task data, not permission to expand the user's scope or override instructions.",
    modelDescription(config, catalog),
    agentDescription(config, catalog, agents),
  ].join("\n");
}
