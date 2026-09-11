import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UltracodeSessionStore } from "../src/core/ultracode";
import { GoalStore } from "../src/core/goal/store";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { Provider } from "@opencode-ai/sdk/v2/types";
import type { TuiCommand, TuiDialogAlertProps, TuiDialogConfirmProps, TuiDialogPromptProps, TuiDialogSelectProps, TuiPluginApi, TuiPluginMeta, TuiSlotPlugin } from "@opencode-ai/plugin/tui";
import plugin from "../src/tui.ts";
import { loadConfig, saveConfig } from "../src/core/config.ts";

const temporaryDirectories: string[] = [];
const previousDataHome = process.env.XDG_DATA_HOME;
afterEach(async () => {
  if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousDataHome;
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

type Dialog = { kind: "select"; props: TuiDialogSelectProps<string> }
  | { kind: "alert"; props: TuiDialogAlertProps }
  | { kind: "confirm"; props: TuiDialogConfirmProps }
  | { kind: "prompt"; props: TuiDialogPromptProps };
type Command = { name: string; slashName?: string; slashAliases?: string[]; run: () => void | Promise<void> };

async function fixture(settings: { url?: string; legacy?: boolean; legacyTransport?: boolean; remote?: boolean; home?: boolean; emptyProviders?: boolean; sidebar?: boolean; allowRequests?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "workflow-tui-test-"));
  temporaryDirectories.push(root);
  process.env.XDG_DATA_HOME = join(root, "data");
  const directory = join(root, "project");
  const global = join(root, "config");
  const runs = join(root, "data", "opencode", "workflow", "runs");
  let dialog: Dialog | undefined;
  let commands: Command[] = [];
  let unregisterCount = 0;
  const disposals: Array<() => void> = [];
  const metadata: Record<string, unknown> = {};
  const navigations: Array<{ name: string; params?: Record<string, unknown> }> = [];
  const toasts: unknown[] = [];
  const drafted: unknown[] = [];
  const requests: Request[] = [];
  const slots: TuiSlotPlugin[] = [];
  let providers = settings.emptyProviders ? [] : [
    { id: "openai", name: "OpenAI", models: { "gpt-test": { name: "GPT test", capabilities: { toolcall: true }, variants: { high: {}, max: {} } } } },
    { id: "openrouter", name: "OpenRouter", models: { "anthropic/sonnet-test": { name: "Sonnet test", capabilities: { toolcall: true } } } },
    { id: "plain", name: "Plain provider", models: { "text-only": { name: "Text only", capabilities: { toolcall: false } } } },
  ] as unknown as Provider[];
  const baseUrl = settings.url ?? "http://opencode.internal";
  const client = settings.legacyTransport ? {
    _client: { getConfig: () => ({ baseUrl }) },
    tui: { appendPrompt: async (request: unknown) => { drafted.push(request); return { data: true }; } },
  } : createOpencodeClient({
    baseUrl,
    fetch: (async (request: Request) => {
      requests.push(request);
      if (settings.allowRequests) return Response.json({});
      throw new Error("Native workflow dialogs must not make network or model requests.");
    }) as unknown as typeof fetch,
  });
  if (!settings.legacyTransport) Object.defineProperty(client.tui, "appendPrompt", {
    value: async (request: unknown) => { drafted.push(request); return { data: true }; },
  });
  const api = {
    slots: settings.sidebar ? { register: (slot: TuiSlotPlugin) => { slots.push(slot); return "workflow-sidebar"; } } : undefined,
    keymap: settings.legacy ? undefined : { registerLayer: (layer: { commands: Command[] }) => { commands = layer.commands; return () => { unregisterCount++; }; } },
    command: { register: (callback: () => TuiCommand[]) => {
      commands = callback().map((command) => ({ name: command.value, slashName: command.slash?.name, slashAliases: command.slash?.aliases, run: () => command.onSelect?.() }));
      return () => { unregisterCount++; };
    } },
    ui: {
      DialogSelect: (props: TuiDialogSelectProps<string>) => ({ kind: "select", props }),
      DialogAlert: (props: TuiDialogAlertProps) => ({ kind: "alert", props }),
      DialogConfirm: (props: TuiDialogConfirmProps) => ({ kind: "confirm", props }),
      DialogPrompt: (props: TuiDialogPromptProps) => ({ kind: "prompt", props }),
      dialog: { replace: (render: () => Dialog) => { dialog = render(); }, clear: () => { dialog = undefined; } },
      toast: (toast: unknown) => { toasts.push(toast); },
    },
    route: {
      current: settings.home ? { name: "home" } : { name: "session", params: { sessionID: "ses_parent" } },
      navigate: (name: string, params?: Record<string, unknown>) => { navigations.push({ name, params }); },
    },
    state: { path: { directory, config: global }, get provider() { return providers; }, session: { get: () => ({ metadata }) } },
    client,
    lifecycle: { onDispose: (callback: () => void) => { disposals.push(callback); } },
  } as unknown as TuiPluginApi;
  await plugin.tui(api, settings.remote ? { remote: true } : undefined, {} as TuiPluginMeta);
  async function command(name: string) {
    const item = commands.find((command) => command.name === name);
    if (!item) throw new Error(`Missing command ${name}`);
    await item.run();
  }
  async function slash(name: string) {
    const item = commands.find((command) => command.slashName === name || command.slashAliases?.includes(name));
    if (!item) throw new Error(`Missing slash command /${name}`);
    await item.run();
  }
  async function choose(value: string) {
    if (dialog?.kind !== "select") throw new Error("Expected a selection dialog");
    const item = dialog.props.options.find((entry) => entry.value === value);
    if (!item) throw new Error(`Missing option ${value}`);
    await dialog.props.onSelect?.(item);
  }
  async function storeRun(overrides: Record<string, unknown> = {}) {
    const id = `wf_${randomUUID()}`;
    const run = {
      id, name: "Review", status: "running", sessionID: "ses_parent", directory, startedAt: 100,
      agents: [{ id: "a_1", label: "Reviewer", model: "openai/gpt-test", status: "running", sessionID: "ses_child" }],
      ...overrides,
    };
    await mkdir(join(runs, id), { recursive: true });
    await writeFile(join(runs, id, "run.json"), JSON.stringify(run));
    return run;
  }
  return { root, directory, global, runs, commands, metadata, toasts, drafted, navigations, requests, client, slots,
    command, slash, choose, storeRun, get dialog() { return dialog; },
    get providers() { return providers; }, setProviders: (next: Provider[]) => { providers = next; },
    get unregisterCount() { return unregisterCount; }, dispose: () => disposals.forEach((callback) => callback()),
  };
}

test("registers native commands with keymap and unregisters on disposal", async () => {
  const f = await fixture();
  expect(plugin.id).toBe("opencode-workflow-engine-tui");
  expect(f.commands.map((command) => command.slashName)).toEqual(["workflow-config", "workflows", "ultracode", "workflow-dismiss", "workflow-goals"]);
  expect(f.commands.find((command) => command.name === "workflow.config")?.slashAliases).toContain("workflow_config");
  f.dispose();
  expect(f.unregisterCount).toBe(1);
  await f.command("workflow.config");
  expect(f.dialog).toBeUndefined();
});

test("supports the installed legacy command API", async () => {
  const f = await fixture({ legacy: true });
  await f.slash("workflow_config");
  expect(f.dialog?.props.title).toBe("Workflow configuration (project)");
});

test("native goal controls persist pause/resume/stop without model or network calls", async () => {
  const f = await fixture();
  const store = new GoalStore(f.directory);
  try {
    const goal = store.create({ sessionID: "ses_parent", agent: "build", model: { providerID: "openai", modelID: "gpt-test" }, objective: "Verify a requested feature" });
    await f.slash("workflow-goals");
    expect(f.dialog?.props.title).toBe("Workflow goal — active");
    await f.choose("pause"); expect(store.get(goal.id)?.mode).toBe("paused");
    await f.choose("resume"); expect(store.get(goal.id)?.mode).toBe("active");
    await f.choose("history"); expect(f.dialog?.props.title).toBe("Workflow goal history");
    await f.choose("back");
    await f.choose("stop");
    expect(store.get(goal.id)?.mode).toBe("active");
    if (f.dialog?.kind !== "confirm") throw new Error("Expected explicit stop confirmation");
    await f.dialog.props.onConfirm?.();
    await Bun.sleep(1);
    expect(store.get(goal.id)?.mode).toBe("cancelled");
    expect(f.requests).toHaveLength(0); expect(f.drafted).toHaveLength(0);
  } finally { f.dispose(); store.close(); }
});

test("native goal creation drafts the singular server command without swallowing its arguments", async () => {
  const f = await fixture({ home: true });
  await f.slash("workflow_goals"); await f.choose("new");
  if (f.dialog?.kind !== "prompt") throw new Error("Expected objective prompt");
  await f.dialog.props.onConfirm?.("Build the feature and verify it"); await Bun.sleep(1);
  expect(f.drafted).toEqual([{ directory: f.directory, text: "/workflow-goal Build the feature and verify it" }]);
  expect(f.requests).toHaveLength(0);
  f.dispose();
});

test("native goal status shows offline ownership and quota waits without rewriting durable state", async () => {
  const f = await fixture();
  const store = new GoalStore(f.directory);
  try {
    const goal = store.create({ sessionID: "ses_parent", agent: "build", model: { providerID: "openai", modelID: "gpt-test" }, objective: "Verify a requested feature" });
    await f.slash("workflow-goals"); await f.choose("status");
    if (f.dialog?.kind !== "alert") throw new Error("Expected goal status");
    expect(f.dialog.props.message).toContain("supervisor offline");
    expect(store.get(goal.id)).toEqual(goal);
    expect(store.claim("test-supervisor", Date.now(), 60_000)).toBe(true);
    const until = Date.now() + 3_600_000;
    store.change(goal.id, "test-quota", current => {
      current.waiting = { kind: "quota", since: Date.now(), until };
      current.coordinator = { providerID: "openai", modelID: "gpt-test", variant: "max" };
    });
    await f.slash("workflow-goals"); await f.choose("status");
    expect(f.dialog.props.message).toContain(`quota until ${new Date(until).toISOString()}`);
    expect(f.dialog.props.message).toContain("openai/gpt-test (max)");
    expect(f.dialog.props.message).not.toContain("supervisor offline");
    store.release("test-supervisor");
    await f.slash("workflow-goals"); await f.choose("status");
    expect(f.dialog.props.message).toContain("supervisor offline");
    expect(store.get(goal.id)?.waiting).toMatchObject({ kind: "quota", until });
    store.control(goal.id, "pause");
    await f.slash("workflow-goals"); await f.choose("status");
    expect(f.dialog.props.message).not.toContain("supervisor offline");
    expect(f.requests).toHaveLength(0); expect(f.drafted).toHaveLength(0);
  } finally { f.dispose(); store.close(); }
});

test("native Ultracode controls persist session preferences without chat or model calls", async () => {
  const f = await fixture();
  await f.slash("ultracode");
  expect(f.dialog?.props.title).toContain("off (this session)");
  await f.choose("on");
  const store = new UltracodeSessionStore(f.directory);
  expect(await store.get("ses_parent")).toMatchObject({ enabled: true, effort: "xhigh" });
  expect(f.dialog?.props.title).toContain("on (this session)");
  await f.choose("high");
  expect(await store.get("ses_parent")).toMatchObject({ enabled: false, effort: "high" });
  await f.choose("reset");
  expect(await store.get("ses_parent")).toBeUndefined();
  expect(f.requests).toEqual([]);
  expect(f.drafted).toEqual([]);
});

test("native prompt bridge stamps human provenance, dismisses once, and unregisters", async () => {
  const f = await fixture({ allowRequests: true });
  const submit = (synthetic = false) => (f.client as TuiPluginApi["client"]).session.prompt({ sessionID: "ses_parent", parts: [{ type: "text", text: "ultracode build", synthetic }] });
  await f.slash("workflow-dismiss");
  await submit(true);
  expect((await f.requests.at(-1)!.clone().json()).parts[0].metadata).toBeUndefined();
  await (f.client as TuiPluginApi["client"]).session.prompt({ sessionID: "ses_parent", parts: [{ type: "text", text: "ultracode from automation", metadata: { workflowOrigin: "automation" } }] });
  expect((await f.requests.at(-1)!.clone().json()).parts[0].metadata).toEqual({ workflowOrigin: "automation" });
  await submit();
  expect((await f.requests.at(-1)!.clone().json()).parts[0].metadata).toEqual({ workflowOrigin: "human", workflowOptOut: true });
  await submit();
  expect((await f.requests.at(-1)!.clone().json()).parts[0].metadata).toEqual({ workflowOrigin: "human" });
  f.dispose();
  await submit();
  expect((await f.requests.at(-1)!.clone().json()).parts[0].metadata).toBeUndefined();
});

test("Ultracode can be enabled at home for the next created session", async () => {
  const f = await fixture({ home: true, allowRequests: true });
  await f.slash("ultracode");
  await f.choose("current");
  expect(f.dialog?.props.title).toContain("on (next session)");
  expect(f.requests).toEqual([]);
  await (f.client as TuiPluginApi["client"]).session.prompt({ sessionID: "ses_new", parts: [{ type: "text", text: "Build this" }] });
  expect(await new UltracodeSessionStore(f.directory).get("ses_new")).toMatchObject({ enabled: true, effort: null });
});

test("pending Ultracode session settings also apply when the first submission is a slash command", async () => {
  const f = await fixture({ home: true, allowRequests: true });
  await f.slash("ultracode");
  await f.choose("on");
  await (f.client as TuiPluginApi["client"]).session.command({ sessionID: "ses_new", command: "workflow", arguments: "Build this" });
  expect(await new UltracodeSessionStore(f.directory).get("ses_new")).toMatchObject({ enabled: true, effort: "xhigh" });
});

test("native automatic defaults and keyword settings honor selected configuration scope", async () => {
  const f = await fixture();
  await f.slash("workflow-config");
  await f.choose("ultracode-default");
  await f.choose("scope");
  await f.choose("ultracode-keyword");
  expect((await loadConfig(f.directory, f.global)).ultracode).toEqual({ enabled: true, keyword: false });
  expect(JSON.parse(await readFile(join(f.global, "workflow.json"), "utf8")).ultracode).toEqual({ keyword: false });
});

test("registers the supported host sidebar slot without network or model calls", async () => {
  const f = await fixture({ sidebar: true });
  expect(f.slots).toHaveLength(1);
  expect(typeof f.slots[0]?.slots.sidebar_content).toBe("function");
  expect(f.requests).toEqual([]);
  f.dispose();
  expect(f.slots[0]!.slots.sidebar_content!({} as never, { session_id: "ses_parent" })).toBeNull();
});

test("planned tasks show rationale before dispatch but cannot send agent skip controls", async () => {
  const f = await fixture();
  const run = await f.storeRun({ agents: [], plan: { summary: "Inspect first", tasks: [
    { id: "inspect", label: "Inspect", model: "openai/gpt-test", agentType: "reviewer", reason: "Reviewer suits code inspection", dependsOn: [] },
  ] } });
  await f.command("workflow.runs");
  await f.choose(run.id);
  expect(f.dialog?.kind === "select" && f.dialog.props.options.some(option => option.title === "Inspect — queued")).toBe(true);
  await f.choose("inspect");
  expect(f.dialog?.kind === "select" && f.dialog.props.options.find(option => option.value === "skip")?.disabled).toBe(true);
  await f.choose("reason");
  expect(f.dialog?.kind === "alert" && f.dialog.props.message).toContain("Reviewer suits code inspection");
});

test.each(["workflow-config", "workflow_config"])("/%s opens native settings with the installed SDK client, without drafting or calling a model", async (name) => {
  const f = await fixture();
  expect("client" in f.client).toBe(true);
  expect("_client" in f.client).toBe(false);
  await f.slash(name);
  expect(f.dialog?.kind).toBe("select");
  expect(f.dialog?.props.title).toBe("Workflow configuration (project)");
  expect(f.drafted).toEqual([]);
  expect(f.requests).toEqual([]);
});

test("legacy transport clients retain local native configuration", async () => {
  const f = await fixture({ legacyTransport: true });
  await f.slash("workflow_config");
  expect(f.dialog?.kind).toBe("select");
  expect(f.dialog?.props.title).toBe("Workflow configuration (project)");
});

test("provider page shows OpenCode connections and filters the model picker by exact provider", async () => {
  const f = await fixture();
  await f.slash("workflow_config");
  await f.choose("models");
  if (f.dialog?.kind !== "select") throw new Error("Expected providers");
  expect(f.dialog.props.options.filter((entry) => entry.value.startsWith("provider:")).map((entry) => entry.value).sort()).toEqual([
    "provider:openai", "provider:openrouter", "provider:plain",
  ]);
  expect(f.dialog.props.options.find((entry) => entry.value === "provider:openrouter")?.title).toContain("OpenRouter");
  expect(f.dialog.props.options.some((entry) => entry.value === "__all")).toBe(true);
  await f.choose("provider:openrouter");
  if (f.dialog?.kind !== "select") throw new Error("Expected models");
  expect(f.dialog.props.options.filter((entry) => !entry.value.startsWith("__")).map((entry) => entry.value)).toEqual(["openrouter/anthropic/sonnet-test"]);
  await f.choose("__back");
  if (f.dialog?.kind !== "select") throw new Error("Expected providers");
  expect(f.dialog.props.options.some((entry) => entry.value === "provider:openai")).toBe(true);
  await f.choose("__back");
  expect(f.dialog?.props.title).toBe("Workflow configuration (project)");
  expect(f.drafted).toEqual([]);
  expect(f.requests).toEqual([]);
});

test("all-model picker groups connected models, toggles exact IDs, and excludes models without tools", async () => {
  const f = await fixture();
  await f.command("workflow.config");
  await f.choose("models");
  await f.choose("__all");
  expect(f.dialog?.kind).toBe("select");
  if (f.dialog?.kind !== "select") throw new Error("Expected picker");
  expect(f.dialog.props.options.find((entry) => entry.value === "openrouter/anthropic/sonnet-test")?.category).toBe("OpenRouter");
  expect(f.dialog.props.options.find((entry) => entry.value === "plain/text-only")?.disabled).toBe(true);
  await f.choose("plain/text-only");
  expect((await loadConfig(f.directory, f.global)).models.allowed).toEqual([]);
  await f.choose("openrouter/anthropic/sonnet-test");
  expect((await loadConfig(f.directory, f.global)).models.allowed).toEqual(["openrouter/anthropic/sonnet-test"]);
  await f.choose("openrouter/anthropic/sonnet-test");
  expect((await loadConfig(f.directory, f.global)).models.allowed).toEqual([]);
});

test("provider model toggles persist and stay in the chosen provider until navigating back", async () => {
  const f = await fixture();
  await f.slash("workflow_config");
  await f.choose("models");
  await f.choose("provider:openai");
  await f.choose("openai/gpt-test");
  if (f.dialog?.kind !== "select") throw new Error("Expected persistent model picker");
  expect(f.dialog.props.options.find((entry) => entry.value === "openai/gpt-test")?.title).toContain("[x]");
  expect(f.dialog.props.options.some((entry) => entry.value === "openrouter/anthropic/sonnet-test")).toBe(false);
  expect((await loadConfig(f.directory, f.global)).models.allowed).toEqual(["openai/gpt-test"]);
  await f.choose("__back");
  await f.choose("provider:openrouter");
  await f.choose("openrouter/anthropic/sonnet-test");
  expect((await loadConfig(f.directory, f.global)).models.allowed).toEqual(["openai/gpt-test", "openrouter/anthropic/sonnet-test"]);
  await f.choose("__back");
  await f.choose("provider:openai");
  await f.choose("openai/gpt-test");
  expect((await loadConfig(f.directory, f.global)).models.allowed).toEqual(["openrouter/anthropic/sonnet-test"]);
});

test("provider and model pages read refreshed OpenCode state instead of a startup snapshot", async () => {
  const f = await fixture();
  await f.slash("workflow_config");
  await f.choose("models");
  await f.choose("provider:openai");
  f.setProviders([{ id: "new", name: "New connection", models: {
    "model/new": { name: "New connected model", capabilities: { toolcall: true } },
  } }] as unknown as Provider[]);
  await f.choose("__back");
  if (f.dialog?.kind !== "select") throw new Error("Expected refreshed providers");
  expect(f.dialog.props.options.some((entry) => entry.value === "provider:openai")).toBe(false);
  expect(f.dialog.props.options.some((entry) => entry.value === "provider:new")).toBe(true);
  await f.choose("provider:new");
  await f.choose("new/model/new");
  expect((await loadConfig(f.directory, f.global)).models.allowed).toEqual(["new/model/new"]);
});

test("deprecated models are hidden and missing tool capabilities fail safely in the pool picker", async () => {
  const f = await fixture();
  f.setProviders([{ id: "safe", name: "Safety fixture", models: {
    current: { name: "Current", status: "active", capabilities: { toolcall: true } },
    retired: { name: "Retired", status: "deprecated", capabilities: { toolcall: true } },
    unknown: { name: "Unknown capability" },
    unspecified: { name: "Missing tool flag", capabilities: {} },
  } }] as unknown as Provider[]);
  await f.slash("workflow_config");
  await f.choose("models");
  await f.choose("provider:safe");
  if (f.dialog?.kind !== "select") throw new Error("Expected models");
  expect(f.dialog.props.options.some((entry) => entry.value === "safe/retired")).toBe(false);
  expect(f.dialog.props.options.find((entry) => entry.value === "safe/unknown")?.disabled).toBe(true);
  expect(f.dialog.props.options.find((entry) => entry.value === "safe/unspecified")?.disabled).toBe(true);
  await f.choose("safe/unknown");
  await f.choose("safe/unspecified");
  expect((await loadConfig(f.directory, f.global)).models.allowed).toEqual([]);
  await f.choose("safe/current");
  expect((await loadConfig(f.directory, f.global)).models.allowed).toEqual(["safe/current"]);
});

test("empty OpenCode catalog provides connection guidance without drafting a model request", async () => {
  const f = await fixture({ emptyProviders: true });
  await f.slash("workflow_config");
  await f.choose("models");
  if (f.dialog?.kind !== "alert") throw new Error("Expected connection guidance");
  expect(f.dialog.props.message).toContain("/connect");
  expect(f.dialog.props.message).toContain("/models");
  expect(f.drafted).toEqual([]);
  expect(f.requests).toEqual([]);
  expect((await loadConfig(f.directory, f.global)).models.allowed).toEqual([]);
});

test("default picker chooses a connected provider then an exact model or session inheritance", async () => {
  const f = await fixture();
  await f.slash("workflow_config");
  await f.choose("default");
  if (f.dialog?.kind !== "select") throw new Error("Expected default providers");
  expect(f.dialog.props.options.some((entry) => entry.value === "session")).toBe(true);
  await f.choose("provider:openrouter");
  if (f.dialog?.kind !== "select") throw new Error("Expected default models");
  expect(f.dialog.props.options.some((entry) => entry.value === "openai/gpt-test")).toBe(false);
  await f.choose("openrouter/anthropic/sonnet-test");
  expect((await loadConfig(f.directory, f.global)).models.default).toBe("openrouter/anthropic/sonnet-test");
  expect(f.dialog?.props.title).toBe("Workflow configuration (project)");
  await f.choose("default");
  await f.choose("__all");
  await f.choose("__back");
  await f.choose("session");
  expect((await loadConfig(f.directory, f.global)).models.default).toBe("session");
});

test("native settings update strict mode, default model, global scope, and remove stale models", async () => {
  const f = await fixture();
  await saveConfig(f.directory, { models: { allowed: ["gone/model"] } }, "project", f.global);
  await f.command("workflow.config");
  await f.choose("strict");
  expect((await loadConfig(f.directory, f.global)).models.strict).toBe(true);
  await f.choose("default");
  await f.choose("provider:openai");
  await f.choose("openai/gpt-test");
  expect((await loadConfig(f.directory, f.global)).models.default).toBe("openai/gpt-test");
  await f.choose("models");
  await f.choose("__unavailable");
  await f.choose("gone/model");
  expect((await loadConfig(f.directory, f.global)).models.allowed).toEqual([]);
  await f.choose("__back");
  await f.choose("__back");
  await f.choose("scope");
  expect(f.dialog?.props.title).toContain("global");
  await f.choose("default");
  await f.choose("session");
  expect(JSON.parse(await readFile(join(f.global, "workflow.json"), "utf8")).models.default).toBe("session");
});

test("size prompt validates input and scoped reset reveals global settings", async () => {
  const f = await fixture();
  await saveConfig(f.directory, { sizeGuideline: 9 }, "global", f.global);
  await f.command("workflow.config");
  await f.choose("size");
  if (f.dialog?.kind !== "prompt") throw new Error("Expected size prompt");
  f.dialog.props.onConfirm?.("4");
  await f.command("workflow.config");
  expect((await loadConfig(f.directory, f.global)).sizeGuideline).toBe(4);
  await f.choose("size");
  if (f.dialog?.kind !== "prompt") throw new Error("Expected size prompt");
  f.dialog.props.onConfirm?.("-2");
  await f.command("workflow.config");
  expect((await loadConfig(f.directory, f.global)).sizeGuideline).toBe(4);
  await f.choose("reset");
  const confirmation = f.dialog as Dialog | undefined;
  if (confirmation?.kind !== "confirm") throw new Error("Expected reset confirmation");
  confirmation.props.onConfirm?.();
  await f.command("workflow.config");
  expect((await loadConfig(f.directory, f.global)).sizeGuideline).toBe(9);
});

test.each(["https://remote.example.test", "http://opencode.local", "not a URL"])("remote or unknown connection cannot edit local config: %s", async (url) => {
  const f = await fixture({ url });
  await f.command("workflow.config");
  expect(f.dialog?.kind).toBe("alert");
  if (f.dialog?.kind !== "alert") throw new Error("Expected remote guidance");
  expect(f.dialog.props.message).toContain("remote");
  expect(f.drafted).toEqual([]);
  f.dialog.props.onConfirm?.();
  await f.command("workflow.runs"); // Drain the serialized callback queue.
  expect(f.drafted).toHaveLength(1);
  expect((await loadConfig(f.directory, f.global)).models.allowed).toEqual([]);
});

test("remote option prevents writes to a server reached through a loopback tunnel", async () => {
  const f = await fixture({ url: "http://localhost:4096", remote: true });
  await f.command("workflow.config");
  expect(f.dialog?.kind).toBe("alert");
});

test("lists only current-session saved runs and lets users navigate to a child", async () => {
  const f = await fixture();
  const run = await f.storeRun();
  await f.storeRun({ sessionID: "ses_other" });
  await f.command("workflow.runs");
  if (f.dialog?.kind !== "select") throw new Error("Expected runs");
  expect(f.dialog.props.options).toHaveLength(1);
  await f.choose(run.id);
  await f.choose("a_1");
  await f.choose("open");
  expect(f.navigations).toEqual([{ name: "session", params: { sessionID: "ses_child" } }]);
});

test("stop and skip create only validated run control files", async () => {
  const f = await fixture();
  const run = await f.storeRun();
  await f.command("workflow.runs");
  await f.choose(run.id);
  await f.choose("a_1");
  await f.choose("skip");
  expect(await readFile(join(f.runs, run.id, "SKIP_a_1"), "utf8")).toContain("workflow TUI");
  await f.choose("__stop");
  expect(await readFile(join(f.runs, run.id, "STOP"), "utf8")).toContain("workflow TUI");
  expect(f.toasts).toHaveLength(2);
});

test("run controls recheck ownership and active status before writing", async () => {
  const f = await fixture();
  const run = await f.storeRun();
  await f.command("workflow.runs");
  await f.choose(run.id);
  await writeFile(join(f.runs, run.id, "run.json"), JSON.stringify({ ...run, sessionID: "ses_other" }));
  await f.choose("__stop");
  expect(f.dialog?.kind).toBe("alert");
  if (f.dialog?.kind !== "alert") throw new Error("Expected error");
  expect(f.dialog.props.message).toContain("current session");
  await expect(readFile(join(f.runs, run.id, "STOP"))).rejects.toThrow();
});

test("a symlink control file cannot overwrite an unrelated target", async () => {
  const f = await fixture();
  const run = await f.storeRun();
  const target = join(f.root, "untouched.txt");
  await writeFile(target, "keep");
  await symlink(target, join(f.runs, run.id, "STOP"));
  await f.command("workflow.runs");
  await f.choose(run.id);
  await f.choose("__stop");
  expect(f.dialog?.kind).toBe("alert");
  expect(await readFile(target, "utf8")).toBe("keep");
});

test("remote workflows use session metadata and offer server-side controls", async () => {
  const f = await fixture({ url: "https://remote.example.test" });
  const run = await f.storeRun();
  f.metadata.workflow = run;
  await f.command("workflow.runs");
  expect(f.dialog?.props.title).toBe("Remote session workflows");
  await f.choose(run.id);
  await f.choose("__stop");
  expect(f.dialog?.kind).toBe("alert");
  await expect(readFile(join(f.runs, run.id, "STOP"))).rejects.toThrow();
});

test("home route shows a useful empty state", async () => {
  const f = await fixture({ home: true });
  await f.command("workflow.runs");
  if (f.dialog?.kind !== "alert") throw new Error("Expected empty state");
  expect(f.dialog.props.message).toContain("Open a session");
});

test("malformed or foreign session metadata cannot provide run controls", async () => {
  const f = await fixture({ url: "https://remote.example.test" });
  f.metadata.workflow = { id: "../../outside", sessionID: "ses_parent", agents: [] };
  await f.command("workflow.runs");
  if (f.dialog?.kind !== "alert") throw new Error("Expected empty state");
  expect(f.dialog.props.message).toContain("No workflow metadata");
  f.metadata.workflow = await f.storeRun({ sessionID: "ses_other" });
  await f.command("workflow.runs");
  expect(f.dialog?.kind).toBe("alert");
});
