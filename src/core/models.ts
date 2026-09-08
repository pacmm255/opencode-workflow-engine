import type { Provider, ProviderListResponse } from "@opencode-ai/sdk/v2/types";
import { effortSchema, type Effort, type WorkflowConfig } from "./config.ts";

export interface ModelEntry {
  /** Exact provider/model identifier, including all slashes in the model ID. */
  id: string;
  providerID: string;
  modelID: string;
  name: string;
  providerName: string;
  variants: string[];
  toolcall: boolean;
}

export interface ModelSelection {
  providerID: string;
  modelID: string;
  variant?: string;
}

type ProviderSnapshot = ProviderListResponse | { providers: Provider[] } | Provider[];

/** Prefer config.providers()'s filtered providers; provider.list() is supported too. */
export function catalogFromProviders(data: ProviderSnapshot): ModelEntry[] {
  const providers = Array.isArray(data) ? data
    : "providers" in data ? data.providers
    : data.all.filter((provider) => data.connected.includes(provider.id));
  const result = new Map<string, ModelEntry>();
  for (const provider of providers) {
    for (const [modelID, model] of Object.entries(provider.models)) {
      const id = `${provider.id}/${modelID}`;
      result.set(id, {
        id,
        providerID: provider.id,
        modelID,
        name: model.name,
        providerName: provider.name,
        variants: Object.keys(model.variants ?? {}).filter((key) => key !== "default").sort(),
        toolcall: model.capabilities.toolcall,
      });
    }
  }
  return [...result.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export class ModelUnavailableError extends Error {
  constructor(message: string, public readonly candidates: string[] = []) {
    super(message);
    this.name = "ModelUnavailableError";
  }
}
export class ModelNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelNotAllowedError";
  }
}
export class VariantNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VariantNotFoundError";
  }
}

interface ResolvedReference { entry: ModelEntry; variant?: string }

function findReference(input: string, catalog: ModelEntry[], aliases: Record<string, string>): ResolvedReference {
  const reference = Object.hasOwn(aliases, input) ? aliases[input]! : input;
  const exact = catalog.find((entry) => entry.id === reference);
  if (exact) return { entry: exact };

  // OpenCode also accepts provider/model/variant. Prefer an actual slash-bearing model.
  const lastSlash = reference.lastIndexOf("/");
  if (lastSlash > 0) {
    const base = catalog.find((entry) => entry.id === reference.slice(0, lastSlash));
    const variant = reference.slice(lastSlash + 1);
    if (base && (variant === "default" || base.variants.includes(variant))) {
      return { entry: base, ...(variant !== "default" ? { variant } : {}) };
    }
  }

  const folded = reference.toLowerCase();
  const exactIDs = catalog.filter((entry) => entry.modelID.toLowerCase() === folded);
  const candidates = exactIDs.length ? exactIDs
    : catalog.filter((entry) => entry.modelID.toLowerCase().endsWith(folded));
  if (candidates.length === 1 && reference.length > 0) return { entry: candidates[0]! };
  if (candidates.length > 1) {
    throw new ModelUnavailableError(`Model ${JSON.stringify(input)} is ambiguous. Use an exact ID: ${candidates.map((entry) => entry.id).join(", ")}`, candidates.map((entry) => entry.id));
  }
  const suggestions = catalog.filter((entry) => entry.id.toLowerCase().includes(folded)).slice(0, 12).map((entry) => entry.id);
  throw new ModelUnavailableError(`Model ${JSON.stringify(input)} is not available from the connected providers.${suggestions.length ? ` Candidates: ${suggestions.join(", ")}.` : " Use workflow_config show to list exact IDs."}`, suggestions);
}

const effortRanks: Record<string, number> = { minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 };

export function variantForEffort(entry: ModelEntry, effort: Effort): string | undefined {
  if (entry.variants.includes(effort)) return effort;
  const rank = effortRanks[effort]!;
  return entry.variants.filter((key) => Object.hasOwn(effortRanks, key)).sort((a, b) => {
    const distance = Math.abs(effortRanks[a]! - rank) - Math.abs(effortRanks[b]! - rank);
    return distance || effortRanks[b]! - effortRanks[a]!;
  })[0];
}

export interface ResolveModelOptions {
  config: WorkflowConfig;
  catalog: ModelEntry[];
  sessionModel: ModelSelection;
  requested?: string;
  /** Pass only when agentType was explicitly selected and that agent has a model. */
  agentModel?: string | ModelSelection;
  effort?: Effort;
  variant?: string;
  onWarning?: (message: string) => void;
}

export function resolveModel(options: ResolveModelOptions): ModelSelection {
  const { config, catalog, sessionModel, requested, agentModel, onWarning } = options;
  const sessionID = `${sessionModel.providerID}/${sessionModel.modelID}`;
  const agentID = typeof agentModel === "string" ? agentModel
    : agentModel ? `${agentModel.providerID}/${agentModel.modelID}` : undefined;
  const source = requested !== undefined ? "explicit" : agentID !== undefined ? "agent"
    : config.models.default !== "session" ? "default" : "session";
  const reference = requested ?? agentID ?? (config.models.default === "session" ? sessionID : config.models.default);
  let resolved: ResolvedReference;
  try {
    resolved = findReference(reference, catalog, source === "explicit" ? config.models.aliases : {});
  } catch (error) {
    if (source !== "default" || !(error instanceof ModelUnavailableError)) throw error;
    onWarning?.(`Configured default ${reference} is unavailable; using session model ${sessionID}.`);
    resolved = findReference(sessionID, catalog, {});
  }
  const { entry } = resolved;
  if (config.models.strict && (source === "explicit" || source === "agent") && !config.models.allowed.includes(entry.id)) {
    throw new ModelNotAllowedError(`Model ${entry.id} is outside the allowed workflow pool (strict mode). Add its exact ID with workflow_config set.`);
  }

  let variant: string | undefined;
  const effort = options.effort ?? config.defaults.effort;
  if (options.variant !== undefined) {
    if (options.variant !== "default" && !entry.variants.includes(options.variant)) {
      throw new VariantNotFoundError(`Variant ${JSON.stringify(options.variant)} is unavailable for ${entry.id}. Available variants: ${entry.variants.join(", ") || "none"}.`);
    }
    variant = options.variant === "default" ? undefined : options.variant;
  } else if (effort !== null) {
    const parsed = effortSchema.safeParse(effort);
    if (!parsed.success) throw new VariantNotFoundError(`Unknown workflow effort: ${String(effort)}.`);
    variant = variantForEffort(entry, parsed.data);
    if (variant !== effort) onWarning?.(`Effort ${effort} on ${entry.id} ${variant ? `maps to variant ${variant}` : "has no supported reasoning variant; using model default"}.`);
  } else if (resolved.variant) {
    variant = resolved.variant;
  } else {
    const inherited = source === "agent" && typeof agentModel === "object" ? agentModel.variant
      : entry.id === sessionID ? sessionModel.variant : undefined;
    if (inherited && inherited !== "default") {
      if (entry.variants.includes(inherited)) variant = inherited;
      else onWarning?.(`Inherited variant ${inherited} is unavailable for ${entry.id}; using model default.`);
    }
  }
  return { providerID: entry.providerID, modelID: entry.modelID, ...(variant ? { variant } : {}) };
}

export function modelDescription(config: WorkflowConfig, catalog: ModelEntry[]): string {
  const entries = new Map(catalog.map((entry) => [entry.id, entry]));
  const lines = [
    `Default workflow model: ${config.models.default === "session" ? "the invoking session model (and its variant)" : config.models.default}.`,
    "Omit model to inherit the default. An explicitly selected agentType can supply its configured model; explicit model overrides take priority.",
    "Copy exact provider/model IDs. Bare model IDs or unique suffixes are accepted; ambiguous references fail. Short names require configured aliases.",
    config.models.strict ? "Strict pool: explicit model choices and agent configured models must appear in allowed, including alias targets. Default/session inheritance remains permitted."
      : "The allowed pool guides autonomous model choice. Honor an explicit user request for any other connected model.",
    "Allowed models:",
  ];
  if (!config.models.allowed.length) lines.push("- No alternate models selected; use the default/session model.");
  for (const id of config.models.allowed) {
    const entry = entries.get(id);
    lines.push(entry ? `- ${id} (${entry.name}); variants: ${entry.variants.join(", ") || "none"}${entry.toolcall ? "" : "; does not support tool calls"}`
      : `- ${id} — WARNING: unavailable from connected providers`);
  }
  for (const [alias, target] of Object.entries(config.models.aliases)) {
    const warning = !entries.has(target) ? "; WARNING: unavailable target"
      : config.models.strict && !config.models.allowed.includes(target) ? "; WARNING: target outside strict pool" : "";
    lines.push(`Alias ${alias} = ${target}${warning}.`);
  }
  if (config.models.default !== "session" && !entries.has(config.models.default)) {
    lines.push(`WARNING: configured default ${config.models.default} is unavailable; the session model will be used.`);
  }
  lines.push("Effort is best-effort: known reasoning levels map to the nearest available level, ties upward. Models with no matching reasoning levels use their default. Explicit variant is exact and fails if unknown; variant default clears inherited effort.");
  if (config.sizeGuideline !== null) lines.push(`Workflow size guideline: aim for at most ${config.sizeGuideline} agents unless the task calls for a different scale. This is advisory; the hard cap is ${config.limits.maxAgents}. Change it with /workflow-config.`);
  return lines.join("\n");
}
