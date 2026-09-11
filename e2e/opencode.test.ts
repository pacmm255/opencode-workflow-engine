import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2";
import type { RunState } from "../src/core/run/state.ts";
import { workflowInstruction } from "../src/core/commands.ts";
import { GoalStore } from "../src/core/goal/store.ts";
import { createHash } from "node:crypto";
import { UltracodeSessionStore } from "../src/core/ultracode.ts";
import { PARENT_MARKER, startModelFixture } from "./fixture.ts";

let suiteDirectory: string;
let projectDirectory: string;
let runDirectory: string;
let serverLog: string;
let serverProcess: Bun.Subprocess | undefined;
let fixture: ReturnType<typeof startModelFixture> | undefined;
let client: OpencodeClient;
let failed = false;
let requestTimeout = 60_000;

const model = { providerID: "fixture", modelID: "test" };

async function poll<T>(description: string, check: () => Promise<T | undefined | false>, timeout = 30_000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await check();
    if (result !== undefined && result !== false) return result;
    if (serverProcess?.exitCode !== null && serverProcess?.exitCode !== undefined) throw new Error(`OpenCode exited (${serverProcess.exitCode}): ${await readFile(serverLog, "utf8")}`);
    await Bun.sleep(150);
  }
  throw new Error(`Timed out waiting for ${description}. Server log: ${serverLog}\n${(await readFile(serverLog, "utf8").catch(() => "")).slice(-12_000)}`);
}

async function healthy(): Promise<void> {
  const [health, statuses] = await Promise.all([
    client.global.health({ signal: AbortSignal.timeout(5_000), throwOnError: true }),
    client.session.status({ directory: projectDirectory }, { signal: AbortSignal.timeout(5_000), throwOnError: true }),
  ]);
  expect(health.data.healthy).toBe(true);
  expect(statuses.data).toBeDefined();
}

async function launch(input: Record<string, unknown>, tool = "workflow"): Promise<string> {
  fixture!.setToolCall(tool, input);
  const { data: session } = await client.session.create({ directory: projectDirectory, title: `Workflow integration ${tool}`, agent: "build", model: { id: model.modelID, providerID: model.providerID } }, { throwOnError: true });
  await client.session.promptAsync({ directory: projectDirectory, sessionID: session.id, agent: "build", model, parts: [{ type: "text", text: `${PARENT_MARKER}: execute the configured ${tool} tool once.` }] }, { throwOnError: true });
  return session.id;
}

async function launchCommand(task: string): Promise<string> {
  const { data: session } = await client.session.create({ directory: projectDirectory, title: "Native workflow command", agent: "build",
    model: { id: model.modelID, providerID: model.providerID } }, { throwOnError: true });
  await client.session.command({ directory: projectDirectory, sessionID: session.id, agent: "build", model: "fixture/test",
    command: "workflow", arguments: task }, { throwOnError: true });
  return session.id;
}

function fixtureText(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map(part => typeof part?.text === "string" ? part.text : "").join("\n") : "";
}

async function toolResult(sessionID: string, tool = "workflow"): Promise<string> {
  return poll(`${tool} tool completion in ${sessionID}`, async () => {
    await healthy();
    const { data: messages } = await client.session.messages({ directory: projectDirectory, sessionID }, { throwOnError: true });
    for (const message of messages) {
      for (const part of message.parts) if (part.type === "tool" && part.tool === tool) {
        if (part.state.status === "error") throw new Error(`Tool ${tool} failed: ${part.state.error}`);
        if (part.state.status === "completed") return part.state.output;
      }
      if (message.info.role === "assistant" && message.info.error) throw new Error(`Parent failed: ${JSON.stringify(message.info.error)}`);
    }
    return undefined;
  });
}

async function parentIdle(sessionID: string): Promise<void> {
  await poll(`parent ${sessionID} to finish its step`, async () => {
    const [{ data: statuses }, { data: messages }] = await Promise.all([
      client.session.status({ directory: projectDirectory }, { throwOnError: true }),
      client.session.messages({ directory: projectDirectory, sessionID }, { throwOnError: true }),
    ]);
    const final = messages.at(-1)?.info;
    return (!statuses[sessionID] || statuses[sessionID]?.type === "idle") && final?.role === "assistant" && final.time.completed !== undefined && final.finish === "stop";
  });
}

async function readRun(id: string): Promise<RunState> {
  return JSON.parse(await readFile(join(runDirectory, id, "run.json"), "utf8"));
}

async function runForParent(sessionID: string): Promise<RunState> {
  return poll(`run belonging to ${sessionID}`, async () => {
    for (const id of await readdir(runDirectory).catch(() => [])) {
      const state = await readRun(id).catch(() => undefined);
      if (state?.sessionID === sessionID) return state;
    }
    return undefined;
  });
}

async function finishedRun(id: string): Promise<RunState> {
  return poll(`run ${id} to settle`, async () => {
    await healthy();
    const run = await readRun(id);
    return run.status !== "running" ? run : undefined;
  });
}

async function childrenIdle(sessionID: string): Promise<void> {
  await poll(`children of ${sessionID} to be idle`, async () => {
    const [{ data: children }, { data: statuses }] = await Promise.all([
      client.session.children({ directory: projectDirectory, sessionID }, { throwOnError: true }),
      client.session.status({ directory: projectDirectory }, { throwOnError: true }),
    ]);
    return children.length > 0 && children.every(child => !statuses[child.id] || statuses[child.id]?.type === "idle");
  });
}

function integration(name: string, action: () => Promise<void>): void {
  test(name, async () => {
    try { await action(); }
    catch (error) { failed = true; throw error; }
  }, 90_000);
}

beforeAll(async () => {
  try {
    const binary = Bun.which("opencode");
    if (!binary) throw new Error("OpenCode CLI is required for integration tests");
    const plugin = resolve(import.meta.dir, "../dist/server.js");
    await readFile(plugin); // Fail clearly before creating processes when the build is missing.
    suiteDirectory = await mkdtemp(join(tmpdir(), "workflow-opencode-e2e-"));
    projectDirectory = join(suiteDirectory, "project");
    const configDirectory = join(suiteDirectory, "config");
    const dataDirectory = join(suiteDirectory, "data");
    runDirectory = join(dataDirectory, "opencode", "workflow", "runs");
    serverLog = join(suiteDirectory, "server.log");
    await mkdir(join(projectDirectory, ".opencode"), { recursive: true });
    await writeFile(join(projectDirectory, ".opencode", "workflow.json"), JSON.stringify({ limits: { maxConcurrency: 2, agentTimeoutMs: 20_000, runTimeoutMs: 40_000, scriptIdleTimeoutMs: 2000 }, defaults: { retries: 0 }, ui: { toasts: false } }));
    for (const args of [["init", "-q"], ["-c", "user.name=Workflow Tests", "-c", "user.email=workflow-tests@example.invalid", "commit", "--allow-empty", "-qm", "Integration fixture"]]) {
      const git = Bun.spawn(["git", ...args], { cwd: projectDirectory, stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
      if (await git.exited !== 0) throw new Error(`Could not initialize isolated git fixture: ${await new Response(git.stderr).text()}`);
    }
    fixture = startModelFixture({
      childText: prompt => `fixture reply:${prompt}`,
      structuredResult: { answer: 42 },
      childDelayMs: prompt => prompt.includes("slow-child") ? 12_000 : prompt.includes("background-child") ? 4000 : 0,
    });
    const reserved = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
    const port = reserved.port!;
    await reserved.stop(true);
    const configuration = {
      plugin: [pathToFileURL(plugin).href],
      enabled_providers: ["fixture"],
      model: "fixture/test", small_model: "fixture/test", share: "disabled", autoupdate: false,
      permission: "allow",
      provider: { fixture: { npm: "@ai-sdk/openai-compatible", name: "Offline fixture", options: { baseURL: `${fixture.url}/v1`, apiKey: "fixture-only" }, models: { test: { name: "Offline test", limit: { context: 32_000, output: 4096 }, cost: { input: 0, output: 0 }, tool_call: true,
        variants: { high: { reasoningEffort: "high" }, xhigh: { reasoningEffort: "xhigh" } } } } } },
    };
    // Only these explicit environment values reach the isolated server. Provider credentials and
    // the user's OpenCode configuration/auth databases are never inherited by the test process.
    serverProcess = Bun.spawn([binary, "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: projectDirectory,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", TERM: "dumb",
        XDG_CONFIG_HOME: configDirectory, XDG_DATA_HOME: dataDirectory,
        XDG_CACHE_HOME: join(suiteDirectory, "cache"), XDG_STATE_HOME: join(suiteDirectory, "state"),
        OPENCODE_CONFIG_DIR: join(configDirectory, "opencode"),
        OPENCODE_CONFIG_CONTENT: JSON.stringify(configuration),
        OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1",
        OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1",
      },
      stdout: Bun.file(serverLog), stderr: Bun.file(serverLog),
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    client = createOpencodeClient({ baseUrl, fetch: ((input, init) => {
      const originalSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      return fetch(input, { ...init, signal: originalSignal ? AbortSignal.any([originalSignal, AbortSignal.timeout(requestTimeout)]) : AbortSignal.timeout(requestTimeout) });
    }) as typeof fetch });
    await poll("OpenCode server startup", async () => {
      try { return (await client.global.health({ signal: AbortSignal.timeout(10_000), throwOnError: true })).data.healthy; }
      catch { return false; }
    }, 60_000);
    // Cold instance bootstrap may install the server's own plugin dependencies.
    await client.session.create({ directory: projectDirectory, title: "Integration bootstrap", agent: "build", model: { id: model.modelID, providerID: model.providerID } }, { signal: AbortSignal.timeout(60_000), throwOnError: true });
    requestTimeout = 10_000;
  } catch (error) { failed = true; throw error; }
}, 90_000);

afterAll(async () => {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill("SIGTERM");
    const exited = await Promise.race([serverProcess.exited.then(() => true), Bun.sleep(5000).then(() => false)]);
    if (!exited) { serverProcess.kill("SIGKILL"); await serverProcess.exited; }
  }
  fixture?.stop();
  if (suiteDirectory) {
    if (failed) console.error(`Integration artifacts retained at ${suiteDirectory}`);
    else await rm(suiteDirectory, { recursive: true, force: true });
  }
}, 10_000);

describe("built plugin in a real isolated OpenCode server", () => {
  integration("workflow-goal command persists a multi-cycle supervisor alongside Ultracode and reports only final acceptance", async () => {
    const criterion = "The isolated goal fixture has passed its acceptance check";
    await writeFile(join(projectDirectory, "goal-proof.txt"), "PASS: offline acceptance fixture");
    fixture!.setAutomaticStages();
    fixture!.setToolCall("workflow_goal", { action: "start", objective: "Complete and verify the isolated goal fixture without unrelated changes" });
    fixture!.setStructuredResult((_schema, prompt) => {
      if (prompt.includes("WORKFLOW_GOAL_CONTRACT_REVIEW")) return { approved: true, issues: [], summary: "The checklist covers exactly the requested fixture" };
      if (prompt.includes("WORKFLOW_GOAL_CONTRACT")) return { criteria: [criterion], summary: "Define the isolated acceptance check" };
      if (prompt.includes("WORKFLOW_GOAL_PLAN")) return { decision: "workflow", summary: "Finish one fixture stage", reason: "Acceptance still needs another stage", question: "", plan: {
        summary: "Goal fixture implementation", tasks: [{ id: "implement", label: "Goal implementation", task: "Inspect the isolated fixture; return the stage result", reason: "Connected fixture model for this bounded stage", model: "fixture/test", dependsOn: [] }],
      } };
      const cycle = Number(/"cycle":(\d+)/.exec(prompt)?.[1] ?? 0);
      return { summary: cycle >= 2 ? "Goal fixture accepted" : "Another stage remains", blocker: "", blockerKind: "none", question: "", evidence: [
        { criterion, met: cycle >= 2, method: "Offline current-state acceptance oracle", observation: cycle >= 2 ? "PASS" : "UNMET", artifact: "goal-proof.txt" },
      ] };
    });
    const { data: session } = await client.session.create({ directory: projectDirectory, title: "Workflow goal integration", agent: "build", model: { id: "test", providerID: "fixture" } }, { throwOnError: true });
    await new UltracodeSessionStore(projectDirectory, join(suiteDirectory, "data", "opencode", "workflow", "ultracode-sessions"))
      .set(session.id, { enabled: true, effort: "xhigh" });
    const store = new GoalStore(projectDirectory, join(suiteDirectory, "data", "opencode", "workflow", "goals", createHash("sha256").update(projectDirectory).digest("hex")));
    try {
      await client.session.command({ directory: projectDirectory, sessionID: session.id, agent: "build", model: "fixture/test", command: "workflow-goal", arguments: `${PARENT_MARKER}: complete the isolated goal` }, { throwOnError: true });
      const output = JSON.parse(await toolResult(session.id, "workflow_goal"));
      expect(output.goal.mode).toBe("active");
      const final = await poll("independent goal acceptance", async () => {
        const goal = store.current(session.id);
        if (goal?.mode === "blocked") throw new Error(`Goal blocked: ${goal.reason}`);
        return goal?.mode === "completed" ? goal : undefined;
      }, 60_000);
      expect(final.cycle).toBe(2);
      expect(final.evidence[0]?.met).toBe(true);
      await poll("final goal notification", async () => store.current(session.id)?.notification === "delivered");
      await parentIdle(session.id);
      const rows = (await Promise.all((await readdir(runDirectory)).map(id => readRun(id).catch(() => undefined)))).filter(row => row?.sessionID === session.id);
      expect(rows).toHaveLength(9);
      expect(rows.every(row => row?.goal?.id === final.id && row.notification === undefined)).toBe(true);
      expect(rows.filter(row => row?.plan)).toHaveLength(2);
      expect(rows.every(row => row?.agents.every(agent => agent.model === "fixture/test/xhigh"))).toBe(true);
      const { data: messages } = await client.session.messages({ directory: projectDirectory, sessionID: session.id }, { throwOnError: true });
      expect(messages.flatMap(message => message.parts).filter(part => part.type === "text" && part.metadata?.workflowGoalResult)).toHaveLength(1);
      expect(messages.flatMap(message => message.parts).some(part => part.type === "text" && part.metadata?.workflowResult)).toBe(false);
      await childrenIdle(session.id);
    } finally {
      const goal = store.current(session.id);
      if (goal && ["active", "blocked", "paused"].includes(goal.mode)) store.control(goal.id, "stop");
      store.close(); fixture!.setStructuredResult({ answer: 42 }); fixture!.setAutomaticStages();
    }
  });

  const autoStage = (id: string) => ({ plan: { summary: `Automatic ${id}`, tasks: [
    { id, label: id, task: `Complete ${id} on the isolated fixture`, reason: "A focused stage with the connected tool-capable model", model: "fixture/test", dependsOn: [] },
  ] } });
  async function automaticPrompt(text: string, metadata?: Record<string, unknown>, sessionMode = false) {
    const { data: session } = await client.session.create({ directory: projectDirectory, title: "Ultracode integration", agent: "build",
      permission: [{ permission: "read", pattern: "private/*", action: "deny" }],
      model: { id: model.modelID, providerID: model.providerID, variant: "high" } }, { throwOnError: true });
    if (sessionMode) await new UltracodeSessionStore(projectDirectory, join(suiteDirectory, "data", "opencode", "workflow", "ultracode-sessions"))
      .set(session.id, { enabled: true, effort: "xhigh" });
    await client.session.promptAsync({ sessionID: session.id, directory: projectDirectory, agent: "build", model, variant: "high",
      parts: [{ type: "text", text: `${PARENT_MARKER}: ${text}`, ...(metadata ? { metadata } : {}) }] }, { throwOnError: true });
    return session.id;
  }

  integration("Ultracode human keyword chains implementation and verification workflows without another user prompt", async () => {
    fixture!.setAutomaticStages([autoStage("implementation"), autoStage("verification")]);
    try {
      const sessionID = await automaticPrompt("ultracode implement and verify", { workflowOrigin: "human" });
      const runs = await poll("both automatic stages and final notification", async () => {
        const rows = await Promise.all((await readdir(runDirectory)).map(id => readRun(id).catch(() => undefined)));
        const owned = rows.filter((row): row is RunState => row?.sessionID === sessionID);
        return owned.length === 2 && owned.every(row => row.status === "completed" && row.notification === "delivered") ? owned.sort((a, b) => a.startedAt - b.startedAt) : undefined;
      });
      await parentIdle(sessionID);
      expect(runs.map(run => run.name)).toEqual(["Automatic implementation", "Automatic verification"]);
      expect(runs[1]!.startedAt).toBeGreaterThanOrEqual(runs[0]!.finishedAt!);
      expect(runs.every(run => run.ultracode?.source === "keyword" && run.launchModel.variant === "high")).toBe(true);
      expect(runs[0]!.ultracode?.messageID).toBe(runs[1]!.ultracode?.messageID);
      const { data: messages } = await client.session.messages({ sessionID, directory: projectDirectory }, { throwOnError: true });
      expect(messages.filter(message => message.info.role === "user" && message.parts.some(part => part.type === "text" && !part.synthetic))).toHaveLength(1);
      const text = messages.flatMap(message => message.parts.filter(part => part.type === "text").map(part => part.text)).join("\n");
      expect(text).toContain("Requested work verified complete.");
      expect(text).not.toContain("const pending = Object.create(null)");
      const { data: children } = await client.session.children({ sessionID, directory: projectDirectory }, { throwOnError: true });
      expect(children).toHaveLength(2);
      for (const child of children) {
        const history = (await client.session.messages({ sessionID: child.id, directory: projectDirectory }, { throwOnError: true })).data;
        expect(JSON.stringify(history)).not.toContain("workflowUltracode");
        expect(child.permission?.some(rule => rule.permission === "workflow*" && rule.action === "deny")).toBe(true);
        expect(child.permission).toContainEqual({ permission: "read", pattern: "private/*", action: "deny" });
      }
    } finally { fixture!.setAutomaticStages(); }
  });

  integration("Ultracode session mode orchestrates plain prompts and applies supported xhigh to parent and children", async () => {
    fixture!.setAutomaticStages([autoStage("session-mode")]);
    try {
      const sessionID = await automaticPrompt("Implement the requested change", undefined, true);
      const run = await runForParent(sessionID);
      const done = await finishedRun(run.id);
      expect(done.ultracode).toMatchObject({ source: "session", effort: "xhigh" });
      expect(done.launchModel.variant).toBe("xhigh");
      expect(done.plan?.tasks[0]?.selectedModel.variant).toBe("xhigh");
      await poll("automatic session result delivery", async () => (await readRun(run.id)).notification === "delivered");
      await parentIdle(sessionID);
      const child = (await client.session.children({ sessionID, directory: projectDirectory }, { throwOnError: true })).data[0]!;
      const childMessages = (await client.session.messages({ sessionID: child.id, directory: projectDirectory }, { throwOnError: true })).data;
      expect(childMessages.find(message => message.info.role === "user")?.info).toHaveProperty("model.variant", "xhigh");
    } finally { fixture!.setAutomaticStages(); }
  });

  integration("plain SDK keywords, per-prompt opt-outs, and simple session questions do not launch workflows", async () => {
    fixture!.setAutomaticStages([autoStage("must-not-launch")]);
    try {
      for (const [text, metadata, mode] of [
        ["ultracode implement this", undefined, false],
        ["ultracode implement this", { workflowOrigin: "human", workflowOptOut: true }, false],
        ["SIMPLE_QUESTION: what is two plus two?", undefined, true],
      ] as const) {
        const sessionID = await automaticPrompt(text, metadata, mode);
        await parentIdle(sessionID);
        expect((await client.session.children({ sessionID, directory: projectDirectory }, { throwOnError: true })).data).toHaveLength(0);
        const messages = (await client.session.messages({ sessionID, directory: projectDirectory }, { throwOnError: true })).data;
        expect(JSON.stringify(messages)).toContain("Direct answer; no workflow needed.");
      }
    } finally { fixture!.setAutomaticStages(); }
  });

  integration("registers commands, agent, and scripting reference", async () => {
    const [{ data: commands }, { data: agents }] = await Promise.all([
      client.command.list({ directory: projectDirectory }, { throwOnError: true }),
      client.app.agents({ directory: projectDirectory }, { throwOnError: true }),
    ]);
    expect(commands.map(command => command.name)).toContain("workflow");
    const commandNames = commands.map(command => command.name);
    expect(commandNames).toContain("workflow-config-chat");
    expect(commandNames).toContain("workflows-chat");
    for (const nativeName of ["workflow-config", "workflow_config", "workflows"]) {
      expect(commandNames).not.toContain(nativeName);
    }
    expect(agents.some(agent => agent.name === "workflow-agent")).toBe(true);
    const sessionID = await launch({}, "workflow_reference");
    expect(await toolResult(sessionID, "workflow_reference")).toContain("pipeline");
    await parentIdle(sessionID);
  });

  integration("native /workflow keeps the task visible, sends hidden guidance, and executes a source-free dependent plan in background", async () => {
    const task = `${PARENT_MARKER}: inspect the isolated project and verify the findings.`;
    const plan = { summary: "Native planned workflow", tasks: [
      { id: "inspect", label: "Inspect", task: "background-child-command-inspect", reason: "Inspect before verification", model: "fixture/test", dependsOn: [] },
      { id: "verify", label: "Verify", task: "native-command-verify", reason: "Verify the completed inspection", model: "fixture/test", dependsOn: ["inspect"] },
    ] };
    const requestStart = fixture!.requests.length;
    fixture!.setToolCall("workflow", { plan });
    const sessionID = await launchCommand(task);
    expect(await toolResult(sessionID)).toContain("Workflow started:");
    const started = await runForParent(sessionID);
    expect(started.background).toBe(true);
    expect(started.plan?.tasks.map(item => item.id)).toEqual(["inspect", "verify"]);
    const initial = (await client.session.messages({ directory: projectDirectory, sessionID }, { throwOnError: true })).data;
    const user = initial.find(message => message.info.role === "user" && message.parts.some(part => part.type === "text" && part.text === task));
    expect(user).toBeDefined();
    expect(user!.parts.filter(part => part.type === "text" && !part.synthetic).map(part => part.type === "text" ? part.text : "")).toEqual([task]);
    expect(user!.parts.some(part => part.type === "text" && part.synthetic === true && part.text === workflowInstruction)).toBe(true);
    const modelRequest = fixture!.requests.slice(requestStart).find(request => request.messages.some(message => fixtureText(message.content).includes(task)));
    expect(modelRequest).toBeDefined();
    expect(modelRequest!.messages.map(message => fixtureText(message.content)).join("\n")).toContain(workflowInstruction);

    const done = await finishedRun(started.id);
    expect(done.status).toBe("completed");
    expect(done.agents.map(agent => agent.taskId)).toEqual(["inspect", "verify"]);
    expect(done.agents.every(agent => agent.status === "completed" && agent.model === "fixture/test")).toBe(true);
    expect((done.result as Record<string, unknown>).verify).toContain("fixture reply:background-child-command-inspect");
    const journal = (await readFile(join(done.runDir, "journal.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(journal.findIndex(event => event.type === "agent.result" && event.agentId === "a_1"))
      .toBeLessThan(journal.findIndex(event => event.type === "agent.start" && event.agentId === "a_2"));
    expect((await client.session.children({ directory: projectDirectory, sessionID }, { throwOnError: true })).data).toHaveLength(2);
    await poll("native planned background notification", async () => (await readRun(done.id)).notification === "delivered");
    await parentIdle(sessionID);
    const history = (await client.session.messages({ directory: projectDirectory, sessionID }, { throwOnError: true })).data;
    const tools = history.flatMap(message => message.parts.filter(part => part.type === "tool"));
    expect(tools.some(part => ["write", "edit", "bash"].includes(part.tool))).toBe(false);
    const invocation = tools.find(part => part.tool === "workflow");
    expect(invocation?.state.status).toBe("completed");
    if (invocation?.state.status !== "completed") throw new Error("Expected completed workflow invocation");
    expect(Object.keys(invocation.state.input)).toEqual(["plan"]);
    expect(JSON.stringify(history)).not.toContain("const pending = Object.create(null)");
    expect(JSON.stringify(history)).not.toContain("export const meta =");
    await childrenIdle(sessionID);
  });

  integration("native /workflow rejects unrelated loop-skill reads while ordinary sessions retain access", async () => {
    const folder = join(projectDirectory, ".claude", "skills", "loop");
    const path = join(folder, "SKILL.md");
    const marker = "ISOLATED_LOOP_SKILL_CONTENT_MUST_NOT_REACH_WORKFLOW";
    await mkdir(folder, { recursive: true });
    await writeFile(path, `---\nname: loop\ndescription: Isolated integration fixture\n---\n${marker}\n`);
    const ordinary = await launch({ filePath: path }, "read");
    expect(await toolResult(ordinary, "read")).toContain(marker);
    await parentIdle(ordinary);

    const requestStart = fixture!.requests.length;
    fixture!.setToolCall("read", { filePath: path });
    const sessionID = await launchCommand(`${PARENT_MARKER}: inspect the isolated project using a workflow.`);
    const rejected = await poll("scoped loop read rejection", async () => {
      const { data: messages } = await client.session.messages({ directory: projectDirectory, sessionID }, { throwOnError: true });
      for (const message of messages) for (const part of message.parts) {
        if (part.type === "tool" && part.tool === "read" && part.state.status === "error") return part.state.error;
      }
      return undefined;
    });
    expect(rejected).toContain("built-in orchestration");
    await parentIdle(sessionID);
    const prompts = fixture!.requests.slice(requestStart).flatMap(request => request.messages.map(message => fixtureText(message.content))).join("\n");
    expect(prompts).not.toContain(marker);
    expect(await readFile(path, "utf8")).toContain(marker);
    expect((await client.session.children({ directory: projectDirectory, sessionID }, { throwOnError: true })).data).toHaveLength(0);
    await healthy();
  });

  integration("native structured output can be read through assistant-only message pages", async () => {
    const { data: session } = await client.session.create({ directory: projectDirectory, agent: "workflow-agent", model: { id: model.modelID, providerID: model.providerID } }, { throwOnError: true });
    await client.session.promptAsync({ directory: projectDirectory, sessionID: session.id, agent: "workflow-agent", model,
      format: { type: "json_schema", schema: { type: "object", properties: { answer: { type: "integer" } }, required: ["answer"] } },
      parts: [{ type: "text", text: "native structured child" }],
    }, { throwOnError: true });
    const assistant = await poll("native structured assistant", async () => {
      const result = await client.session.messages({ directory: projectDirectory, sessionID: session.id, limit: 1 });
      if (result.error) {
        if (!JSON.stringify(result.error).includes("OutputFormatJsonSchema")) throw new Error(JSON.stringify(result.error));
        return undefined;
      }
      const info = result.data?.at(-1)?.info;
      return info?.role === "assistant" && info.time.completed !== undefined ? info : undefined;
    });
    expect(assistant.structured).toEqual({ answer: 42 });
    const full = await client.session.messages({ directory: projectDirectory, sessionID: session.id });
    if (full.error) {
      expect(JSON.stringify(full.error)).toContain("OutputFormatJsonSchema");
      console.info(`Native format compatibility diagnostic: HTTP ${full.response.status} ${JSON.stringify(full.error)}`);
    }
  });

  integration("executes parallel real children and native StructuredOutput without wedging, then resumes from journal", async () => {
    const script = `export const meta = {name:'Integration',description:'Parallel children and structured result'};
      phase('Read');
      const values=await parallel([()=>agent('plain-child'),()=>agent('structured-child',{schema:{type:'object',properties:{answer:{type:'integer'}},required:['answer']}})]);
      return values;`;
    const sessionID = await launch({ script });
    const output = await toolResult(sessionID);
    expect(output).toContain("completed");
    const run = await finishedRun((await runForParent(sessionID)).id);
    expect(run.status).toBe("completed");
    expect(run.result).toEqual(["fixture reply:plain-child", { answer: 42 }]);
    expect(run.agents.every(agent => agent.model === "fixture/test")).toBe(true);
    const { data: children } = await client.session.children({ directory: projectDirectory, sessionID }, { throwOnError: true });
    expect(children).toHaveLength(2);
    expect(run.usage.output).toBeGreaterThan(0);
    await parentIdle(sessionID);
    const resumedParent = await launch({ script, resumeFromRunId: run.id });
    expect(await toolResult(resumedParent)).toContain("2 cached");
    const resumed = await finishedRun((await runForParent(resumedParent)).id);
    expect(resumed.result).toEqual(run.result);
    expect(resumed.agents.every(agent => agent.status === "cached")).toBe(true);
    expect((await client.session.children({ directory: projectDirectory, sessionID: resumedParent }, { throwOnError: true })).data).toHaveLength(0);
    await parentIdle(resumedParent);
    await healthy();
  });

  integration("background child survives the invoking tool step and publishes completion", async () => {
    const sessionID = await launch({ script: "return await agent('background-child')", background: true });
    expect(await toolResult(sessionID)).toContain("Workflow started:");
    await parentIdle(sessionID);
    const run = await runForParent(sessionID);
    await client.session.abort({ directory: projectDirectory, sessionID }, { throwOnError: true });
    await Bun.sleep(150);
    expect((await readRun(run.id)).status).toBe("running");
    const final = await finishedRun(run.id);
    expect(final.status).toBe("completed");
    expect(final.result).toBe("fixture reply:background-child");
    await poll("background notification", async () => (await readRun(run.id)).notification === "delivered");
    await childrenIdle(sessionID);
  });

  integration("STOP file aborts a background run and its real child session", async () => {
    const sessionID = await launch({ script: "return await agent('slow-child-stop')", background: true });
    await toolResult(sessionID);
    const run = await runForParent(sessionID);
    await poll("background child creation", async () => (await client.session.children({ directory: projectDirectory, sessionID }, { throwOnError: true })).data.length > 0);
    await writeFile(join(run.runDir, "STOP"), "integration stop\n");
    expect((await finishedRun(run.id)).status).toBe("aborted");
    await childrenIdle(sessionID);
  });

  integration("SKIP file produces null and leaves the skipped child idle", async () => {
    const sessionID = await launch({ script: "return await agent('slow-child-skip')", background: true });
    await toolResult(sessionID);
    const run = await runForParent(sessionID);
    await poll("skippable child creation", async () => (await client.session.children({ directory: projectDirectory, sessionID }, { throwOnError: true })).data.length > 0);
    await writeFile(join(run.runDir, "SKIP_a_1"), "integration skip\n");
    const final = await finishedRun(run.id);
    expect(final.status).toBe("completed");
    expect(final.result).toBeNull();
    expect(final.agents[0]?.status).toBe("skipped");
    await childrenIdle(sessionID);
  });

  integration("foreground parent abort also aborts the run and all children", async () => {
    const sessionID = await launch({ script: "return await agent('slow-child-foreground')" });
    const run = await runForParent(sessionID);
    await poll("foreground child creation", async () => (await client.session.children({ directory: projectDirectory, sessionID }, { throwOnError: true })).data.length > 0);
    await client.session.abort({ directory: projectDirectory, sessionID }, { throwOnError: true });
    expect((await finishedRun(run.id)).status).toBe("aborted");
    await childrenIdle(sessionID);
    await healthy();
  });

  integration("worktree isolation executes in a distinct retained checkout and branch", async () => {
    const sessionID = await launch({ script: "return await agent('worktree-child', {isolation:'worktree'})" });
    await toolResult(sessionID);
    const run = await finishedRun((await runForParent(sessionID)).id);
    expect(run.status).toBe("completed");
    expect(run.result).toBe("fixture reply:worktree-child");
    const directory = run.agents[0]?.directory;
    expect(directory).toBeDefined();
    expect(directory).not.toBe(projectDirectory);
    expect(directory!.startsWith(suiteDirectory)).toBe(true);
    const branch = Bun.spawn(["git", "branch", "--show-current"], { cwd: directory, stdout: "pipe", stderr: "pipe" });
    expect(await branch.exited).toBe(0);
    expect((await new Response(branch.stdout).text()).trim()).not.toBe("");
    const { data: child } = await client.session.get({ sessionID: run.agents[0]!.sessionID!, directory }, { throwOnError: true });
    expect(child.directory).toBe(directory!);
    await healthy();
  });
});
