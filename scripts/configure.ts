import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { applyEdits, getNodeValue, modify, parseTree, type ParseError } from "jsonc-parser";

type Plugin = string | [string, Record<string, unknown>];
interface Snapshot {
  file: string;
  text?: string;
  mode?: number;
  ino?: number;
  dev?: number;
  plugins?: Plugin[];
}
interface Plan { original: Snapshot; text: string }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function plugin(value: unknown): value is Plugin {
  if (typeof value === "string") return value.trim().length > 0;
  return Array.isArray(value) && value.length === 2
    && typeof value[0] === "string" && value[0].trim().length > 0 && object(value[1]);
}

function parseConfig(text: string, file: string): Plugin[] | undefined {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length || root?.type !== "object") throw new Error(`Invalid JSON/JSONC object in ${file}; nothing was changed.`);
  const keys = new Set<string>();
  for (const property of root.children ?? []) {
    const key = property.children?.[0]?.value as string;
    if (keys.has(key)) throw new Error(`Duplicate top-level key ${JSON.stringify(key)} in ${file}; nothing was changed.`);
    keys.add(key);
  }
  const config = getNodeValue(root) as Record<string, unknown>;
  if (!Object.hasOwn(config, "plugin")) return;
  if (!Array.isArray(config.plugin) || !config.plugin.every(plugin)) {
    throw new Error(`Invalid plugin array in ${file}; nothing was changed.`);
  }
  return config.plugin;
}

async function snapshot(file: string): Promise<Snapshot> {
  let stat;
  try { stat = await lstat(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { file };
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing non-regular config file ${file}.`);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error(`Config changed while being read: ${file}.`);
    const text = await handle.readFile("utf8");
    const after = await handle.stat();
    if (opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) {
      throw new Error(`Config changed while being read: ${file}.`);
    }
    return { file, text, mode: opened.mode & 0o777, ino: opened.ino, dev: opened.dev, plugins: parseConfig(text, file) };
  } finally { await handle.close(); }
}

function hasPlugin(snapshot: Snapshot, url: string): boolean {
  return snapshot.plugins?.some(value => (Array.isArray(value) ? value[0] : value) === url) ?? false;
}

function append(original: Snapshot, url: string): Plan | undefined {
  if (hasPlugin(original, url)) return;
  const input = original.text ?? "{}\n";
  // Editing one array element retains comments on existing plugins and other settings.
  const location = original.plugins ? ["plugin", original.plugins.length] : ["plugin"];
  const value = original.plugins ? url : [url];
  const text = applyEdits(input, modify(input, location, value, {
    isArrayInsertion: Boolean(original.plugins),
    // Formatting an insertion can also reformat the preceding user's object or
    // tuple. Leave existing files' bytes alone; only format brand-new files.
    ...(original.text === undefined ? { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } } : {}),
  }));
  parseConfig(text, original.file);
  return { original, text };
}

async function unchanged(original: Snapshot): Promise<void> {
  const current = await snapshot(original.file);
  if (current.text !== original.text || current.ino !== original.ino || current.dev !== original.dev || current.mode !== original.mode) {
    throw new Error(`Config changed during installation: ${original.file}. Retry after finishing your edits.`);
  }
}

async function exclusiveWrite(file: string, text: string, mode: number): Promise<void> {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    await handle.writeFile(text, "utf8");
    await handle.chmod(mode);
    await handle.sync();
  } finally { await handle.close(); }
}

/** Register both plugins without defaulting to, or guessing, any user's config directory. */
export async function configureInstallation(options: { configDir: string; pluginDir: string; dryRun?: boolean }): Promise<void> {
  if (!isAbsolute(options.configDir) || !isAbsolute(options.pluginDir)) {
    throw new Error("Both configDir and pluginDir must be absolute directories.");
  }
  const directory = resolve(options.configDir);
  const server = await Promise.all(["config.json", "opencode.json", "opencode.jsonc"].map(name => snapshot(join(directory, name))));
  const tui = await Promise.all(["tui.json", "tui.jsonc"].map(name => snapshot(join(directory, name))));
  // Global server files replace arrays. Add to the winning existing array instead
  // of creating a higher-precedence array that would hide the user's plugins.
  const serverTarget = [...server].reverse().find(item => item.plugins !== undefined)
    ?? [...server].reverse().find(item => item.text !== undefined) ?? server[2]!;
  const tuiTarget = [...tui].reverse().find(item => item.text !== undefined) ?? tui[1]!;
  const serverURL = pathToFileURL(join(resolve(options.pluginDir), "dist", "server.js")).href;
  const tuiURL = pathToFileURL(join(resolve(options.pluginDir), "dist", "tui.js")).href;
  const plans = [append(serverTarget, serverURL), tui.some(item => hasPlugin(item, tuiURL)) ? undefined : append(tuiTarget, tuiURL)]
    .filter((plan): plan is Plan => plan !== undefined);
  if (options.dryRun || plans.length === 0) return;

  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockFile = join(directory, ".workflow-engine-install.lock");
  let lock: FileHandle;
  try { lock = await open(lockFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Another registration may be running (${lockFile}).`);
    throw error;
  }
  const staged: { plan: Plan; temporary: string }[] = [];
  try {
    // Recheck every candidate, including absent higher-priority files, after acquiring the lock.
    for (const original of [...server, ...tui]) await unchanged(original);
    for (const plan of plans) {
      const suffix = `${Date.now()}-${randomUUID()}`;
      const temporary = `${plan.original.file}.workflow-engine-${suffix}.tmp`;
      staged.push({ plan, temporary });
      await exclusiveWrite(temporary, plan.text, plan.original.mode ?? 0o600);
      if (plan.original.text !== undefined) {
        await exclusiveWrite(`${plan.original.file}.workflow-engine-backup-${suffix}`, plan.original.text, plan.original.mode!);
      }
    }
    for (const original of [...server, ...tui]) await unchanged(original);
    for (const { plan, temporary } of staged) {
      await unchanged(plan.original);
      if (plan.original.text === undefined) {
        // link(), unlike rename(), never overwrites a concurrently created config.
        await link(temporary, plan.original.file);
        await unlink(temporary);
      } else {
        await rename(temporary, plan.original.file);
      }
    }
  } finally {
    try {
      for (const { temporary } of staged) await unlink(temporary).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    } finally {
      await lock.close();
      await unlink(lockFile);
    }
  }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    let configDir: string | undefined;
    let pluginDir: string | undefined;
    let dryRun = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--check" && !dryRun) dryRun = true;
      else if ((arg === "--config-dir" && !configDir) || (arg === "--plugin-dir" && !pluginDir)) {
        const value = args[++i];
        if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}.`);
        if (arg === "--config-dir") configDir = value;
        else pluginDir = value;
      } else throw new Error(`Unknown or repeated option: ${arg}.`);
    }
    if (!configDir || !pluginDir) throw new Error("Usage: bun run scripts/configure.ts --config-dir DIR --plugin-dir DIR [--check]");
    await configureInstallation({ configDir, pluginDir, dryRun });
    console.log(dryRun ? "OpenCode configuration checks passed." : "Server and native dialog plugins registered. Original modified configs have unique backup files.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
