import { cpus, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const effortSchema = z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]);
export type Effort = z.infer<typeof effortSchema>;

const modelRef = z.string().regex(/^[^/\s]+\/[^\s]+$/, "Expected a provider/model ID");
const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const duration = positiveInteger.max(2_147_483_647);
const modelsSchema = z.strictObject({
  allowed: z.array(modelRef),
  default: z.union([z.literal("session"), modelRef]),
  strict: z.boolean(),
  aliases: z.record(z.string().min(1), modelRef),
});
const limitsSchema = z.strictObject({
  maxConcurrency: positiveInteger.max(256),
  maxAgents: positiveInteger,
  maxItems: positiveInteger,
  agentTimeoutMs: duration,
  runTimeoutMs: duration,
  scriptIdleTimeoutMs: duration,
  syncTimeoutMs: duration,
});
const defaultsSchema = z.strictObject({
  agent: z.string().trim().min(1),
  retries: z.number().int().min(0).max(10),
  effort: effortSchema.nullable(),
});
const uiSchema = z.strictObject({ toasts: z.boolean() });
const ultracodeSchema = z.strictObject({ enabled: z.boolean(), keyword: z.boolean() });

export const configSchema = z.strictObject({
  models: modelsSchema,
  limits: limitsSchema,
  defaults: defaultsSchema,
  sizeGuideline: positiveInteger.nullable(),
  ui: uiSchema,
  ultracode: ultracodeSchema,
});
export type WorkflowConfig = z.infer<typeof configSchema>;

export const configPatchSchema = z.strictObject({
  models: modelsSchema.partial().optional(),
  limits: limitsSchema.partial().optional(),
  defaults: defaultsSchema.partial().optional(),
  sizeGuideline: positiveInteger.nullable().optional(),
  ui: uiSchema.partial().optional(),
  ultracode: ultracodeSchema.partial().optional(),
});
export type ConfigPatch = z.infer<typeof configPatchSchema>;
export type ConfigScope = "project" | "global";

export const defaultConfig: WorkflowConfig = {
  models: { allowed: [], default: "session", strict: false, aliases: {} },
  limits: {
    maxConcurrency: Math.max(1, Math.min(16, cpus().length - 2)),
    maxAgents: 1000,
    maxItems: 4096,
    agentTimeoutMs: 1_800_000,
    runTimeoutMs: 21_600_000,
    scriptIdleTimeoutMs: 120_000,
    syncTimeoutMs: 5000,
  },
  defaults: { agent: "workflow-agent", retries: 1, effort: null },
  sizeGuideline: 15,
  ui: { toasts: true },
  ultracode: { enabled: false, keyword: true },
};

export class ConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigError";
  }
}

export function configPaths(directory: string, globalConfigDir?: string) {
  const globalDirectory = globalConfigDir ?? join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
  return {
    global: resolve(globalDirectory, "workflow.json"),
    project: resolve(directory, ".opencode", "workflow.json"),
  };
}

function parsePatch(value: unknown, source: string): ConfigPatch {
  const parsed = configPatchSchema.safeParse(value);
  if (!parsed.success) {
    throw new ConfigError(`Invalid workflow config ${source}: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ")}`);
  }
  return parsed.data;
}

async function readPatch(file: string): Promise<ConfigPatch> {
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new ConfigError(`Cannot read workflow config ${file}`, { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new ConfigError(`Invalid JSON in workflow config ${file}`, { cause: error });
  }
  return parsePatch(value, file);
}

/** Sections merge by field; arrays replace, and alias maps merge by alias name. */
function mergePatches(base: ConfigPatch, patch: ConfigPatch): ConfigPatch {
  return {
    ...base,
    ...patch,
    ...(base.models || patch.models ? { models: {
      ...base.models,
      ...patch.models,
      ...(base.models?.aliases || patch.models?.aliases ? {
        aliases: { ...base.models?.aliases, ...patch.models?.aliases },
      } : {}),
    } } : {}),
    ...(base.limits || patch.limits ? { limits: { ...base.limits, ...patch.limits } } : {}),
    ...(base.defaults || patch.defaults ? { defaults: { ...base.defaults, ...patch.defaults } } : {}),
    ...(base.ui || patch.ui ? { ui: { ...base.ui, ...patch.ui } } : {}),
    ...(base.ultracode || patch.ultracode ? { ultracode: { ...base.ultracode, ...patch.ultracode } } : {}),
  };
}

export async function loadConfig(directory: string, globalConfigDir?: string): Promise<WorkflowConfig> {
  const paths = configPaths(directory, globalConfigDir);
  const [globalPatch, projectPatch] = await Promise.all([readPatch(paths.global), readPatch(paths.project)]);
  return effectiveConfig(globalPatch, projectPatch);
}

function effectiveConfig(globalPatch: ConfigPatch, projectPatch: ConfigPatch): WorkflowConfig {
  return configSchema.parse(mergePatches(mergePatches(defaultConfig, globalPatch), projectPatch));
}

// Serialize read/modify/write operations on one file within this plugin process.
const writers = new Map<string, Promise<unknown>>();
async function withWriter<T>(file: string, action: () => Promise<T>): Promise<T> {
  const previous = writers.get(file) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(action);
  writers.set(file, pending);
  try {
    return await pending;
  } finally {
    if (writers.get(file) === pending) writers.delete(file);
  }
}

async function atomicWrite(file: string, value: ConfigPatch) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function saveConfig(
  directory: string,
  patch: ConfigPatch,
  scope: ConfigScope = "project",
  globalConfigDir?: string,
): Promise<WorkflowConfig> {
  if (scope !== "global" && scope !== "project") throw new ConfigError(`Unknown config scope: ${scope}`);
  const validated = parsePatch(patch, "update");
  const paths = configPaths(directory, globalConfigDir);
  const file = paths[scope];
  return withWriter(file, async () => {
    const [globalPatch, projectPatch] = await Promise.all([readPatch(paths.global), readPatch(paths.project)]);
    const next = mergePatches(scope === "global" ? globalPatch : projectPatch, validated);
    const effective = effectiveConfig(scope === "global" ? next : globalPatch, scope === "project" ? next : projectPatch);
    await atomicWrite(file, next);
    return effective;
  });
}

/** Remove this scope's overrides, revealing values inherited from the other scope. */
export async function resetConfig(
  directory: string,
  scope: ConfigScope = "project",
  globalConfigDir?: string,
): Promise<WorkflowConfig> {
  if (scope !== "global" && scope !== "project") throw new ConfigError(`Unknown config scope: ${scope}`);
  const paths = configPaths(directory, globalConfigDir);
  const file = paths[scope];
  return withWriter(file, async () => {
    const otherPatch = await readPatch(paths[scope === "global" ? "project" : "global"]);
    const effective = effectiveConfig(scope === "global" ? {} : otherPatch, scope === "project" ? {} : otherPatch);
    await unlink(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    return effective;
  });
}
