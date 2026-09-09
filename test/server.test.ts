import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import type { PluginInput, ToolContext } from "@opencode-ai/plugin";
import plugin from "../src/server.ts";
import { defaultConfig, loadConfig } from "../src/core/config.ts";
import { authoringSkillContent } from "../src/core/authoring-skill.ts";
import { goalInstruction, workflowInstruction } from "../src/core/commands.ts";
import { UltracodeSessionStore, ultracodeOriginKey, workflowResultKey } from "../src/core/ultracode.ts";

const previousConfigHome = process.env.XDG_CONFIG_HOME;
const previousDataHome = process.env.XDG_DATA_HOME;
const previousCacheHome = process.env.XDG_CACHE_HOME;
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
  if (previousCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = previousCacheHome;
});

async function fixture(options: { malformed?: boolean; hold?: Promise<void>; parentID?: string; variants?: string[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "workflow-server-test-"));
  process.env.XDG_CONFIG_HOME = join(root, "config");
  process.env.XDG_DATA_HOME = join(root, "data");
  process.env.XDG_CACHE_HOME = join(root, "cache");
  const directory = join(root, "project");
  if (options.malformed) {
    await mkdir(join(directory, ".opencode"), { recursive: true });
    await writeFile(join(directory, ".opencode", "workflow.json"), "{ invalid config");
  }
  const requests: string[] = [];
  let history: unknown[] = [];
  const transport = {
    baseUrl: "http://workflow.test",
    fetch: (async (request: Request) => {
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (options.hold) await options.hold;
      if (path === "/config/providers") return Response.json({ providers: [
        { id: "test", name: "Test provider", models: { "nested/model": { name: "Nested model", capabilities: { toolcall: true }, variants: Object.fromEntries((options.variants ?? ["high", "max"]).map(name => [name, {}])) } } },
      ], default: { test: "nested/model" } });
      if (path === "/agent") return Response.json([{ name: "workflow-agent", mode: "subagent" }]);
      if (path === "/session/ses_parent/message/msg_parent") return Response.json({ info: { role: "assistant", providerID: "test", modelID: "nested/model" }, parts: [] });
      if (path === "/session/ses_parent/message") return Response.json(history);
      if (path === "/session/ses_parent") return Response.json({ id: "ses_parent", parentID: options.parentID, model: { providerID: "test", id: "nested/model" } });
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
  async function chat(text: string, options: { human?: boolean; synthetic?: boolean; optOut?: boolean; metadata?: Record<string, unknown> } = {}) {
    const output = { message: { id: "msg_human", sessionID: "ses_parent", role: "user", agent: "build", time: { created: 1 },
      model: { providerID: "test", modelID: "nested/model", variant: "high" } },
      parts: [{ id: "prt_human", sessionID: "ses_parent", messageID: "msg_human", type: "text", text, synthetic: options.synthetic,
        metadata: { ...(options.human ? { [ultracodeOriginKey]: "human" } : {}), ...(options.optOut ? { workflowOptOut: true } : {}), ...options.metadata } }],
    } as Parameters<NonNullable<typeof hooks["chat.message"]>>[1];
    await hooks["chat.message"]?.({ sessionID: "ses_parent" }, output);
    return output;
  }
  return { root, directory, hooks, requests, execute, chat, setHistory: (value: unknown[]) => { history = value; } };
}

test("initializes through v1 transport and exposes workflow tools", async () => {
  const f = await fixture();
  expect(plugin.id).toBe("opencode-workflow-engine");
  expect(Object.keys(f.hooks.tool ?? {}).sort()).toEqual(["workflow", "workflow_config", "workflow_goal", "workflow_mode", "workflow_reference", "workflow_runs", "workflow_saved"]);
  expect(f.requests).toEqual([]);
  expect(await f.execute("workflow_reference", {})).toContain("agent(prompt");
});

test("workflow-goal is a server command with preserved arguments and no second Ultracode planner", async () => {
  const f = await fixture();
  await f.execute("workflow_mode", { action: "set", enabled: true });
  const output = { parts: [{ type: "text", text: "Build and verify the requested feature" }] };
  await f.hooks["command.execute.before"]?.({ command: "workflow-goal", sessionID: "ses_parent", arguments: output.parts[0]!.text }, output as any);
  expect(output.parts[0]?.text).toBe("Build and verify the requested feature");
  expect(output.parts[1]).toMatchObject({ text: goalInstruction, synthetic: true });
  const raw = await f.chat("/workflow-goal ultracode build a feature", { human: true });
  expect(JSON.stringify(raw)).toContain(goalInstruction);
  expect(JSON.stringify(raw)).not.toContain("Ultracode workflow assistance is opted in");
});

test("goal tools persist lifecycle, never expose manual completion, and retain Ultracode settings", async () => {
  const f = await fixture();
  await f.execute("workflow_mode", { action: "set", enabled: true });
  const started = JSON.parse(await f.execute("workflow_goal", { action: "start", objective: "Build the requested feature; do not publish" }));
  expect(started.goal.mode).toBe("active");
  expect(started.goal.originalObjective).toContain("do not publish");
  await expect(f.execute("workflow_goal", { action: "start", objective: "Second goal" })).rejects.toThrow("already has a goal");
  expect(JSON.parse(await f.execute("workflow_goal", { action: "pause" })).goal.mode).toBe("paused");
  expect(JSON.parse(await f.execute("workflow_goal", { action: "resume" })).goal.mode).toBe("active");
  expect(JSON.parse(await f.execute("workflow_mode", { action: "show" })).settings.enabled).toBe(true);
  expect(JSON.parse(await f.execute("workflow_goal", { action: "stop" })).goal.mode).toBe("cancelled");
  await expect(f.execute("workflow_goal", { action: "resume" })).rejects.toThrow("ended");
  expect(JSON.parse(await f.execute("workflow_goal", { action: "history" })).events.length).toBeGreaterThan(3);
});

test("active goals suppress competing parent writes and survive compaction without rewriting the objective", async () => {
  const f = await fixture();
  await f.execute("workflow_goal", { action: "start", objective: "Implement within the existing scope" });
  const output = await f.chat("What is the status?", { human: true });
  expect(JSON.stringify(output)).toContain("goal owns execution");
  await expect(f.hooks["tool.execute.before"]?.({ tool: "write", sessionID: "ses_parent", callID: "call" }, { args: {} })).rejects.toThrow("Pause the goal");
  const compact = { context: [] as string[] };
  await f.hooks["experimental.session.compacting"]?.({ sessionID: "ses_parent" }, compact);
  expect(compact.context.join(" ")).toContain("Implement within the existing scope");
  await f.execute("workflow_goal", { action: "pause" });
});

test("automatic keyword triggering requires trusted human metadata and stays one-shot", async () => {
  const f = await fixture();
  const plain = await f.chat("ultracode implement this");
  expect(plain.parts).toHaveLength(1);
  const human = await f.chat("ultracode implement this", { human: true });
  expect(human.parts.at(-1)).toMatchObject({ type: "text", synthetic: true, metadata: { workflowUltracode: true } });
  expect(human.parts.at(-1)?.type === "text" && human.parts.at(-1)).toHaveProperty("text", expect.stringContaining("smallest sufficient team"));
  expect(human.message.model).toHaveProperty("variant", "high");
  expect(await new UltracodeSessionStore(f.directory).get("ses_parent")).toBeUndefined();
  const next = await f.chat("Thanks. What did you change?", { human: true });
  expect(next.parts).toHaveLength(1);
  const messages = { messages: [ { info: human.message, parts: human.parts }, { info: { ...next.message, id: "msg_next" }, parts: next.parts } ] };
  await f.hooks["experimental.chat.messages.transform"]?.({}, messages);
  expect(messages.messages[0]!.parts).toHaveLength(1);
});

test("enabled mode reaches ordinary requests, exact xhigh reaches the parent, and opt-out wins", async () => {
  const f = await fixture({ variants: ["high", "xhigh", "max"] });
  const store = new UltracodeSessionStore(f.directory);
  await store.set("ses_parent", { enabled: true });
  const output = await f.chat("Implement this change");
  expect(output.parts.at(-1)).toHaveProperty("synthetic", true);
  expect(output.message.model).toHaveProperty("variant", "xhigh");
  expect((await f.chat("Implement this without workflows")).parts).toHaveLength(1);
  const dismissed = await f.chat("ultracode implement this", { human: true, optOut: true });
  expect(dismissed.parts).toHaveLength(1);
  expect(dismissed.message.model).toHaveProperty("variant", "high");
  expect((await f.chat("ultracode implement this", { synthetic: true })).parts).toHaveLength(1);
  const compact = { context: [] as string[] };
  await f.chat("Implement and verify the change");
  await f.hooks["experimental.session.compacting"]?.({ sessionID: "ses_parent" }, compact);
  expect(compact.context.join("\n")).toContain("Implement and verify the change");
});

test("unsupported xhigh preserves real variant and workflow_mode is scoped to one session", async () => {
  const f = await fixture();
  const mode = JSON.parse(await f.execute("workflow_mode", { action: "set", enabled: true }));
  expect(mode.settings).toMatchObject({ enabled: true, effort: "xhigh" });
  expect((await f.chat("Build this")).message.model).toHaveProperty("variant", "high");
  expect((await loadConfig(f.directory)).ultracode.enabled).toBe(false);
  expect(await new UltracodeSessionStore(f.directory).get("ses_other")).toBeUndefined();
  await f.execute("workflow_mode", { action: "set", enabled: false, effort: "high" });
  const high = await f.chat("Build this");
  expect(high.parts).toHaveLength(1);
  expect(high.message.model).toHaveProperty("variant", "high");
  await f.execute("workflow_mode", { action: "reset" });
  expect(await new UltracodeSessionStore(f.directory).get("ses_parent")).toBeUndefined();
});

test("children never receive automatic orchestration or session mode controls", async () => {
  const f = await fixture({ parentID: "ses_grandparent", variants: ["high", "xhigh"] });
  await new UltracodeSessionStore(f.directory).set("ses_parent", { enabled: true });
  const child = await f.chat("ultracode build this", { human: true });
  expect(child.parts).toHaveLength(1);
  expect(child.message.model).toHaveProperty("variant", "high");
  await expect(f.execute("workflow_mode", { action: "set", enabled: true })).rejects.toThrow("top-level session");
});

test("only a completed owned result continues the original request, without reviving interrupted or superseded work", async () => {
  const f = await fixture();
  const original = await f.chat("ultracode implement and verify", { human: true });
  f.setHistory([{ info: original.message, parts: original.parts }]);
  const id = "wf_11111111-1111-4111-8111-111111111111";
  const runDir = join(f.root, "data", "opencode", "workflow", "runs", id);
  await mkdir(runDir, { recursive: true });
  const state = { id, sessionID: "ses_parent", directory: f.directory, runDir, status: "completed", agents: [],
    ultracode: { messageID: "msg_human", task: "ultracode implement and verify", source: "keyword", effort: null } };
  const notify = () => f.chat("<workflow_result>Stage finished</workflow_result>", { synthetic: true, metadata: { [workflowResultKey]: id } });
  await writeFile(join(runDir, "run.json"), JSON.stringify(state));
  const next = await notify();
  expect(next.parts).toHaveLength(2);
  expect(next.parts.at(-1)).toHaveProperty("text", expect.stringContaining("Original user request"));
  f.setHistory([{ info: { ...original.message, id: "msg_later" }, parts: original.parts }]);
  expect((await notify()).parts).toHaveLength(1);
  f.setHistory([{ info: original.message, parts: original.parts }]);
  for (const patch of [{ status: "aborted" }, { status: "timeout" }, { sessionID: "ses_other" }, { agents: [{ status: "skipped" }] }]) {
    await writeFile(join(runDir, "run.json"), JSON.stringify({ ...state, ...patch }));
    expect((await notify()).parts).toHaveLength(1);
  }
  await writeFile(join(runDir, "run.json"), JSON.stringify(state));
  await new UltracodeSessionStore(f.directory).set("ses_parent", { enabled: false });
  expect((await notify()).parts).toHaveLength(1);
});

test("config hook registers commands, subagent, and absolute skill path without replacing user commands", async () => {
  const f = await fixture();
  const existing = { template: "User-owned workflow command" };
  const config = { command: { workflow: existing } } as Parameters<NonNullable<typeof f.hooks.config>>[0];
  await f.hooks.config?.(config);
  expect(config.command?.workflow).toEqual(existing);
  expect(Object.keys(config.command ?? {}).sort()).toEqual(["ultracode-chat", "workflow", "workflow-config-chat", "workflow-goal", "workflow-stop", "workflows-chat"]);
  for (const nativeName of ["workflow-config", "workflow_config", "workflows"]) {
    expect(config.command).not.toHaveProperty(nativeName);
  }
  expect(config.command?.["workflow-config-chat"]?.description).toContain("Chat fallback");
  expect(config.command?.["workflows-chat"]?.description).toContain("Chat fallback");
  expect(config.agent?.["workflow-agent"]?.mode).toBe("subagent");
  const skills = (config as unknown as { skills: { paths: string[] } }).skills.paths;
  expect(skills).toHaveLength(1);
  expect(isAbsolute(skills[0]!)).toBe(true);
  expect(skills[0]).toStartWith(join(f.root, "cache", "opencode", "workflow", "skills") + "/");
  expect(await readFile(join(skills[0]!, "workflow-authoring", "SKILL.md"), "utf8")).toBe(authoringSkillContent);
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

test("workflow command shows the user's task, keeping setup instructions synthetic", async () => {
  const f = await fixture();
  const config = {} as Parameters<NonNullable<typeof f.hooks.config>>[0];
  await f.hooks.config?.(config);
  expect(config.command?.workflow?.template).toBe("$ARGUMENTS");
  const parts = [{ type: "text", text: "Build a spaceship game" }, { type: "file", url: "file:///fixture/art.png" }];
  const output = { parts } as Parameters<NonNullable<typeof f.hooks["command.execute.before"]>>[1];
  await f.hooks["command.execute.before"]?.({ command: "workflow", sessionID: "ses_parent", arguments: "Build a spaceship game" }, output);
  expect(output.parts.filter(part => part.type === "text" && !part.synthetic).map(part => part.type === "text" ? part.text : "")).toEqual(["Build a spaceship game"]);
  expect(output.parts.at(-1)).toMatchObject({ type: "text", text: workflowInstruction, synthetic: true });
  expect(output.parts[1]).toMatchObject({ type: "file", url: "file:///fixture/art.png" });
  expect(workflowInstruction).toContain("declarative plan");
  expect(workflowInstruction).toContain("smallest sufficient team");
  expect(workflowInstruction).toContain("Do not write a workflow script");
  expect(f.requests).toEqual([]);
});

test("a user-owned workflow command is not rewritten or given plugin setup instructions", async () => {
  const f = await fixture();
  await f.hooks.config?.({ command: { workflow: { template: "My own command: $ARGUMENTS" } } });
  const output = { parts: [{ type: "text", text: "My own command: example" }] } as Parameters<NonNullable<typeof f.hooks["command.execute.before"]>>[1];
  await f.hooks["command.execute.before"]?.({ command: "workflow", sessionID: "ses_parent", arguments: "example" }, output);
  expect(output.parts).toHaveLength(1);
});

test("raw slash fallback preserves visible task and adds model-only workflow instructions", async () => {
  const f = await fixture();
  const output = { message: {}, parts: [{ type: "text", text: "/workflow Write a mini game" }] } as Parameters<NonNullable<typeof f.hooks["chat.message"]>>[1];
  await f.hooks["chat.message"]?.({ sessionID: "ses_parent" }, output);
  expect(output.parts).toHaveLength(2);
  expect(output.parts[0]).toMatchObject({ type: "text", text: "Write a mini game" });
  expect(output.parts[1]).toMatchObject({ synthetic: true, text: workflowInstruction });
  await f.hooks["chat.message"]?.({ sessionID: "ses_parent" }, output);
  expect(output.parts).toHaveLength(2);
});

test("unrelated Claude loop reads are rejected only during a workflow request", async () => {
  const f = await fixture();
  const output = { parts: [] } as Parameters<NonNullable<typeof f.hooks["command.execute.before"]>>[1];
  await f.hooks["command.execute.before"]?.({ command: "workflow", sessionID: "ses_parent", arguments: "Write a mini spaceship game" }, output);
  const call = { tool: "read", sessionID: "ses_parent", callID: "call_example" };
  const args = { filePath: "/root/.claude/skills/loop/SKILL.md" };
  await expect(f.hooks["tool.execute.before"]!(call, { args })).rejects.toThrow("built-in orchestration");
  await expect(f.hooks["tool.execute.before"]!({ ...call, tool: "skill" }, { args: { name: "loop" } })).rejects.toThrow("built-in orchestration");
  await f.hooks["tool.execute.before"]!({ ...call, sessionID: "ses_other" }, { args });
  await f.hooks["tool.execute.before"]!(call, { args: { filePath: "/root/.claude/skills/frontend-design/SKILL.md" } });
  const next = { message: {}, parts: [{ type: "text", text: "A different task" }] } as Parameters<NonNullable<typeof f.hooks["chat.message"]>>[1];
  await f.hooks["chat.message"]?.({ sessionID: "ses_parent" }, next);
  await f.hooks["tool.execute.before"]!(call, { args });
});

test("an explicitly requested loop skill remains available without modifying global discovery", async () => {
  const f = await fixture();
  await f.hooks["command.execute.before"]?.({ command: "workflow", sessionID: "ses_parent", arguments: "Review my loop skill" }, { parts: [] });
  await f.hooks["tool.execute.before"]?.({ tool: "skill", sessionID: "ses_parent", callID: "call_example" }, { args: { name: "loop" } });
  const config = { permission: { bash: "ask" } } as Parameters<NonNullable<typeof f.hooks.config>>[0];
  await f.hooks.config?.(config);
  expect(config.permission).toEqual({ bash: "ask" });
});

test("workflow reference refreshes actual models and configured roles before planning", async () => {
  const f = await fixture();
  const reference = await f.execute("workflow_reference", {});
  expect(f.requests).toContain("/config/providers");
  expect(f.requests).toContain("/agent");
  expect(reference).toContain("workflow-agent");
  expect(reference).toContain("smallest sufficient team");
  expect(reference).toContain("model and selection reason");
  expect(reference).toContain("Effective default model ID: test/nested/model");
  expect(f.hooks.tool?.workflow?.args).toHaveProperty("plan");
});
