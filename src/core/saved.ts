import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { globalConfigDirectory, validateName } from "./paths";
import { failure } from "./errors";
import { validateScript } from "./script/validate";

export class SavedWorkflows {
  constructor(readonly directory: string, readonly globalDirectory = globalConfigDirectory(),
    readonly builtins = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../../workflows/" : "../workflows/", import.meta.url))) {}
  private folder(scope: "project" | "global"): string {
    return scope === "project" ? join(this.directory, ".opencode", "workflows") : join(this.globalDirectory, "workflows");
  }
  async list(): Promise<Array<{ name: string; scope: string; path: string }>> {
    const rows: Array<{ name: string; scope: string; path: string }> = [];
    const seen = new Set<string>();
    for (const [scope, folder] of [["project", this.folder("project")], ["global", this.folder("global")], ["builtin", this.builtins]] as const) {
      const entries = await readdir(folder).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
      for (const file of entries.sort()) if (/^[a-zA-Z0-9][a-zA-Z0-9_-]*\.js$/.test(file) && !seen.has(file)) {
        seen.add(file); rows.push({ name: file.slice(0, -3), scope, path: join(folder, file) });
      }
    }
    return rows;
  }
  async load(input: { script?: string; scriptPath?: string; name?: string }): Promise<string> {
    if ([input.script, input.scriptPath, input.name].filter((value) => value !== undefined).length !== 1)
      throw failure("WorkflowInputError", "Provide exactly one of script, scriptPath or name");
    if (input.script !== undefined) return input.script;
    let path: string;
    if (input.scriptPath !== undefined) path = resolve(this.directory, input.scriptPath);
    else {
      validateName(input.name!);
      const entry = (await this.list()).find((item) => item.name === input.name);
      if (!entry) throw failure("WorkflowNotFoundError", `Unknown workflow: ${input.name}`);
      path = entry.path;
    }
    try { return await readFile(path, "utf8"); }
    catch (error) { throw failure("WorkflowUnreadableError", `Cannot read ${path}: ${String(error)}`); }
  }
  async save(name: string, script: string, scope: "project" | "global" = "project"): Promise<string> {
    validateName(name); validateScript(script);
    const folder = this.folder(scope);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const path = join(folder, `${name}.js`);
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, script, { mode: 0o600 });
    await rename(temp, path);
    return path;
  }
  async delete(name: string, scope: "project" | "global" = "project"): Promise<string> {
    validateName(name);
    const path = join(this.folder(scope), `${name}.js`);
    const archive = join(this.folder(scope), ".trash", `${name}.${Date.now()}.${randomUUID()}.js`);
    await mkdir(join(this.folder(scope), ".trash"), { recursive: true, mode: 0o700 });
    await rename(path, archive);
    return archive;
  }
}
