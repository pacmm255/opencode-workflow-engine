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
  /** Provider catalog metadata, not measured quality or a billing guarantee. */
  status?: string;
  family?: string;
  capabilities?: {
    reasoning: boolean | null;
    attachment: boolean | null;
    input: string[] | null;
    output: string[] | null;
  };
  /** OpenCode reports USD per million tokens. Missing prices remain unknown. */
  cost?: {
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
    tiered: boolean;
  };
  limits?: { context: number | null; input: number | null; output: number | null };
}

export interface ModelSelection {
  providerID: string;
  modelID: string;
  variant?: string;
}

type ProviderSnapshot = ProviderListResponse | { providers: Provider[] } | Provider[];

function nonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function positive(value: unknown): number | null {
  const number = nonnegative(value);
  return number !== null && number > 0 ? number : null;
}

function knownBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function modalities(value: Record<string, boolean> | undefined): string[] | null {
  return value ? Object.entries(value).filter(([, enabled]) => enabled === true).map(([name]) => name).sort() : null;
}

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
        toolcall: model.capabilities?.toolcall === true,
        ...(model.status ? { status: model.status } : {}),
        ...(model.family ? { family: model.family } : {}),
        capabilities: {
          reasoning: knownBoolean(model.capabilities?.reasoning),
          attachment: knownBoolean(model.capabilities?.attachment),
          input: modalities(model.capabilities?.input),
          output: modalities(model.capabilities?.output),
        },
        cost: {
          input: nonnegative(model.cost?.input),
          output: nonnegative(model.cost?.output),
          cacheRead: nonnegative(model.cost?.cache?.read),
          cacheWrite: nonnegative(model.cost?.cache?.write),
          tiered: Boolean(model.cost?.tiers?.length || model.cost?.experimentalOver200K),
        },
        limits: {
          context: positive(model.limit?.context),
          input: positive(model.limit?.input),
          output: positive(model.limit?.output),
        },
      });
    }
  }
  return [...result.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Autonomous alternatives only. An empty pool does not authorize every connected model. */
export function modelPlanningCatalog(config: WorkflowConfig, catalog: ModelEntry[]): ModelEntry[] {
  const allowed = new Set(config.models.allowed);
  return catalog.filter((entry) => allowed.has(entry.id) && entry.toolcall && entry.status !== "deprecated");
}

function catalogDetails(entry: ModelEntry): string {
  const known = (value: boolean | null | undefined) => value === null || value === undefined ? "unknown" : value ? "yes" : "no";
  const price = (value: number | null | undefined) => nonnegative(value) === null ? "unknown" : `$${value}`;
  const limit = (value: number | null | undefined) => positive(value) ?? "unknown";
  return [
    `variants: ${entry.variants.join(", ") || "none"}`,
    `tool calls: ${entry.toolcall ? "yes" : "no"}`,
    `reasoning: ${known(entry.capabilities?.reasoning)}`,
    `attachments: ${known(entry.capabilities?.attachment)}`,
    `input modalities: ${entry.capabilities?.input?.join(", ") || (entry.capabilities?.input ? "none" : "unknown")}`,
    `output modalities: ${entry.capabilities?.output?.join(", ") || (entry.capabilities?.output ? "none" : "unknown")}`,
    `context/input/output token limits: ${limit(entry.limits?.context)}/${limit(entry.limits?.input)}/${limit(entry.limits?.output)}`,
    `catalog USD/1M tokens input ${price(entry.cost?.input)}, output ${price(entry.cost?.output)}, cache read ${price(entry.cost?.cacheRead)}, cache write ${price(entry.cost?.cacheWrite)}${entry.cost?.tiered ? " (additional pricing tiers apply)" : ""}`,
    ...(entry.status ? [`status: ${entry.status}`] : []),
  ].join("; ");
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
    "Omitting model inherits the default; this is a fallback, not a recommendation to assign the session model to every task. An explicitly selected agentType can supply its configured model; explicit model overrides take priority.",
    "Copy exact provider/model IDs. Bare model IDs or unique suffixes are accepted; ambiguous references fail. Short names require configured aliases.",
    config.models.strict ? "Strict pool: explicit model choices and agent configured models must appear in allowed, including alias targets. Default/session inheritance remains permitted."
      : "The allowed pool guides autonomous model choice. Honor an explicit user request for any other connected model.",
    "For autonomous assignments, compare the connected, tool-capable, non-deprecated models in the allowed pool against each task; select deliberately rather than repeatedly inheriting the session model. Do not invent capability rankings or claim that a name or reasoning flag proves quality.",
    "Prefer a less costly sufficient model when catalog prices are comparable and task requirements are met; reserve stronger reasoning or larger context for tasks that need it. Catalog prices may be incomplete, configured estimates, or tier-dependent; unknown is not free, and a reported $0 is not proof of free service or available quota.",
    "Allowed models:",
  ];
  if (!config.models.allowed.length) lines.push("- No alternate models selected; use the default/session model.");
  for (const id of config.models.allowed) {
    const entry = entries.get(id);
    lines.push(entry ? `- ${id} (${entry.name}; connection: ${entry.providerName}); ${catalogDetails(entry)}${!entry.toolcall || entry.status === "deprecated" ? "; WARNING: not usable for autonomous workflow assignments" : ""}`
      : `- ${id} — WARNING: unavailable from connected providers`);
  }
  if (config.models.allowed.length && !modelPlanningCatalog(config, catalog).length) {
    lines.push("WARNING: no configured allowed model is currently usable for autonomous assignments. Refresh connections or correct the pool; do not silently select an unrelated connected model.");
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
