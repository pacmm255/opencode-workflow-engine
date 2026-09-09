import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { PluginInput, ToolContext } from "@opencode-ai/plugin";
import plugin from "../src/server.ts";
import { defaultConfig, loadConfig } from "../src/core/config.ts";

const previousConfigHome = process.env.XDG_CONFIG_HOME;
const previousDataHome = process.env.XDG_DATA_HOME;
const cleanup: Array<{ root: string; dispose: () => Promise<void> }> = [];
afterEach(async () => {
  for (const fixture of cleanup.splice(0)) {
    await fixture.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
  if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousConfigHome;
  if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousDataHome;
});

async function fixture(options: { malformed?: boolean; hold?: Promise<void> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "workflow-server-test-"));
  process.env.XDG_CONFIG_HOME = join(root, "config");
  process.env.XDG_DATA_HOME = join(root, "data");
  const directory = join(root, "project");
  if (options.malformed) {
    await mkdir(join(directory, ".opencode"), { recursive: true });
    await writeFile(join(directory, ".opencode", "workflow.json"), "{ invalid config");
  }
  const requests: string[] = [];
  const transport = {
    baseUrl: "http://workflow.test",
    fetch: (async (request: Request) => {
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (options.hold) await options.hold;
      if (path === "/config/providers") return Response.json({ providers: [
        { id: "test", name: "Test provider", models: { "nested/model": { name: "Nested model", capabilities: { toolcall: true }, variants: { high: {}, max: {} } } } },
      ], default: { test: "nested/model" } });
      if (path === "/agent") return Response.json([{ name: "workflow-agent", mode: "subagent" }]);
      throw new Error(`Unexpected API request: ${path}`);
    }) as typeof fetch,
  };
  const hooks = await plugin.server({
    client: { _client: { getConfig: () => transport } }, directory,
    serverUrl: new URL(transport.baseUrl), worktree: directory, project: { id: "test" },
  } as unknown as PluginInput);
  cleanup.push({ root, dispose: async () => { await hooks.dispose?.(); } });
  const context: ToolContext = {
    sessionID: "ses_parent", messageID: "msg_parent", agent: "build", directory, worktree: directory,
    abort: new AbortController().signal, metadata: () => {}, ask: async () => {},
  };
  async function execute(name: string, input: Record<string, unknown>) {
    const tool = hooks.tool?.[name];
    if (!tool) throw new Error(`Missing tool ${name}`);
    const response = await tool.execute(input, context);
    return typeof response === "string" ? response : response.output;
  }
  return { root, directory, hooks, requests, execute };
}

test("initializes through v1 transport and exposes all five workflow tools", async () => {
  const f = await fixture();
  expect(plugin.id).toBe("opencode-workflow-engine");
  expect(Object.keys(f.hooks.tool ?? {}).sort()).toEqual(["workflow", "workflow_config", "workflow_reference", "workflow_runs", "workflow_saved"]);
  expect(f.requests).toEqual([]);
  expect(await f.execute("workflow_reference", {})).toContain("agent(prompt");
});

test("config hook registers commands, subagent, and absolute skill path without replacing user commands", async () => {
  const f = await fixture();
  const existing = { template: "User-owned workflow command" };
  const config = { command: { workflow: existing } } as Parameters<NonNullable<typeof f.hooks.config>>[0];
  await f.hooks.config?.(config);
  expect(config.command?.workflow).toEqual(existing);
  expect(Object.keys(config.command ?? {}).sort()).toEqual(["workflow", "workflow-config-chat", "workflow-stop", "workflows-chat"]);
  for (const nativeName of ["workflow-config", "workflow_config", "workflows"]) {
    expect(config.command).not.toHaveProperty(nativeName);
  }
  expect(config.command?.["workflow-config-chat"]?.description).toContain("Chat fallback");
  expect(config.command?.["workflows-chat"]?.description).toContain("Chat fallback");
  expect(config.agent?.["workflow-agent"]?.mode).toBe("subagent");
  const skills = (config as unknown as { skills: { paths: string[] } }).skills.paths;
  expect(skills).toHaveLength(1);
  expect(isAbsolute(skills[0]!)).toBe(true);
  expect(skills[0]).toBe(fileURLToPath(new URL("../dist/skills/", import.meta.url)));
  await f.hooks.config?.(config);
  expect((config as unknown as { skills: { paths: string[] } }).skills.paths).toHaveLength(1);
});

test("server reset repairs malformed scoped config without fetching providers", async () => {
  const f = await fixture({ malformed: true });
  const result = JSON.parse(await f.execute("workflow_config", { action: "reset" }));
  expect(result.config).toEqual(defaultConfig);
  expect(await loadConfig(f.directory)).toEqual(defaultConfig);
  expect(f.requests).toEqual([]);
  await expect(readFile(join(f.directory, ".opencode", "workflow.json"))).rejects.toThrow();
});

test("server config set validates exact connected model references before persistence", async () => {
  const f = await fixture();
  const saved = JSON.parse(await f.execute("workflow_config", { action: "set", config: { models: { allowed: ["test/nested/model"], strict: true } } }));
  expect(saved.config.models.allowed).toEqual(["test/nested/model"]);
  expect(saved.models[0].modelID).toBe("nested/model");
  const before = await readFile(join(f.directory, ".opencode", "workflow.json"), "utf8");
  await expect(f.execute("workflow_config", { action: "set", config: { models: { allowed: ["disconnected/model"] } } })).rejects.toThrow("Not a connected provider/model ID");
  expect(await readFile(join(f.directory, ".opencode", "workflow.json"), "utf8")).toBe(before);
  await expect(f.execute("workflow_config", { action: "set", config: { models: { aliases: { fast: "disconnected/model" } } } })).rejects.toThrow("Not a connected provider/model ID");
});

test("dynamic descriptions use cached config and never await network refresh", async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const f = await fixture({ hold });
  const output = { description: "Workflow description", parameters: {} };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      f.hooks["tool.definition"]?.({ toolID: "workflow" }, output),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Tool listing waited for the network")), 300); }),
    ]);
    expect(output.description).toContain("Default workflow model");
  } finally { clearTimeout(timeout); release(); }
  await f.execute("workflow_config", { action: "set", config: { models: { allowed: ["test/nested/model"] } } });
  const refreshed = { description: "Workflow description", parameters: {} };
  await f.hooks["tool.definition"]?.({ toolID: "workflow" }, refreshed);
  expect(refreshed.description).toContain("test/nested/model");
  expect(refreshed.description).toContain("high, max");
  const unrelated = { description: "Unchanged", parameters: {} };
  const count = f.requests.length;
  await f.hooks["tool.definition"]?.({ toolID: "other" }, unrelated);
  expect(unrelated.description).toBe("Unchanged");
  expect(f.requests.length).toBe(count);
});
