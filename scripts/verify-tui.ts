import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PARENT_MARKER, startModelFixture } from "../e2e/fixture.ts";

/**
 * Real keyboard-and-screen regression checks, not a mock of the plugin API.
 * Requires tmux and OpenCode on PATH. Every OpenCode location and provider is an
 * isolated fixture; no user configuration or provider credentials are inherited.
 */
const tmux = Bun.which("tmux");
const opencode = Bun.which("opencode");
if (!tmux || !opencode) throw new Error("Real TUI verification requires tmux and OpenCode on PATH.");

const root = await mkdtemp(join(tmpdir(), "workflow-tui-check-"));
const project = join(root, "project");
const config = join(root, "config", "opencode");
const socket = join(root, "tmux.sock");
const projectConfig = join(project, ".opencode", "workflow.json");
const globalConfig = join(config, "workflow.json");
const log = join(root, "data", "opencode", "log", "opencode.log");
const subprocessEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", TERM: "xterm-256color" };
let screen = "";
let success = false;
let checks = 0;
let fixture: ReturnType<typeof startModelFixture> | undefined;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function command(args: string[], tolerateFailure = false): Promise<string> {
  const child = Bun.spawn([tmux!, "-f", "/dev/null", "-S", socket, ...args], {
    env: subprocessEnv, stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  if (code && !tolerateFailure) throw new Error(`tmux ${args[0]} failed: ${stderr || stdout}`);
  return stdout;
}

async function capture(): Promise<string> {
  screen = await command(["capture-pane", "-p", "-t", "verify"]);
  return screen;
}

async function waitFor(description: string, predicate: (value: string) => boolean | Promise<boolean>, timeout = 15_000): Promise<string> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const current = await capture();
    if (await predicate(current)) return current;
    await Bun.sleep(120);
  }
  throw new Error(`Timed out waiting for ${description}.\n${screen}`);
}

async function keys(...values: string[]): Promise<void> {
  await command(["send-keys", "-t", "verify", ...values]);
}

async function type(value: string): Promise<void> {
  await command(["send-keys", "-t", "verify", "-l", value]);
}

async function choose(label: string): Promise<void> {
  await keys("C-u");
  await type(label);
  await waitFor(`filtered option ${label}`, value => value.includes(label));
  await keys("Enter");
}

async function settings(alias: "workflow_config" | "workflow-config"): Promise<void> {
  await type(`/${alias}`);
  await waitFor(`${alias} completion`, value => value.includes(`/${alias}`) && value.includes("Configure workflow"));
  await keys("Enter");
  await waitFor(`${alias} native settings`, value => value.includes("Workflow configuration (") && value.includes("Connected providers and model pool"));
  assert(!screen.includes("User request:"), `${alias} must not submit the chat fallback`);
  await writeFile(join(root, `${alias}.txt`), screen);
}

async function ultracode(): Promise<void> {
  await type("/ultracode");
  await waitFor("Ultracode completion", value => value.includes("Configure Ultracode"));
  await keys("Enter");
  await waitFor("native Ultracode controls", value => value.includes("Enable Ultracode") && value.includes("Use configured default"));
}

async function newSession(): Promise<void> {
  await keys("C-x", "n");
  await waitFor("new session home", value => !value.includes("Workflows") && value.includes("commands"));
}

async function patch(file: string): Promise<{ models?: { allowed?: string[]; default?: string; strict?: boolean } }> {
  return JSON.parse(await readFile(file, "utf8"));
}

function passed(message: string): void {
  checks++;
  console.log(`✓ ${message}`);
}

try {
  const dist = resolve(import.meta.dir, "../dist");
  await Promise.all([readFile(join(dist, "server.js")), readFile(join(dist, "tui.js"))]);
  await Promise.all([project, config, join(root, "data"), join(root, "cache"), join(root, "state")].map(directory => mkdir(directory, { recursive: true })));
  fixture = startModelFixture({ childDelayMs: 4500, childText: "Verified the isolated sidebar fixture." });
  const baseModel = { limit: { context: 32_000, output: 4096 }, cost: { input: 0, output: 0 }, tool_call: true,
    variants: { high: { reasoningEffort: "high" }, xhigh: { reasoningEffort: "xhigh" } } };
  const provider = (name: string, models: Record<string, unknown>) => ({
    npm: "@ai-sdk/openai-compatible", name,
    options: { baseURL: `${fixture!.url}/v1`, apiKey: "isolated-fixture-only" }, models,
  });
  await writeFile(join(config, "opencode.json"), JSON.stringify({
    plugin: [pathToFileURL(join(dist, "server.js")).href],
    enabled_providers: ["fixture", "second-fixture"],
    model: "fixture/family/reviewer", small_model: "fixture/family/reviewer", share: "disabled", autoupdate: false,
    provider: {
      fixture: provider("Local Fixture Connection", {
        "family/reviewer": { ...baseModel, name: "Fixture Reviewer" },
        planner: { ...baseModel, name: "Fixture Planner" },
        "text-only": { ...baseModel, name: "Fixture Text Only", tool_call: false },
        retired: { ...baseModel, name: "Retired Fixture Model", status: "deprecated" },
      }),
      "second-fixture": provider("Second Fixture Connection", { coder: { ...baseModel, name: "Fixture Coder" } }),
      disabled: provider("Disabled Fixture Connection", { hidden: { ...baseModel, name: "Hidden Fixture Model" } }),
    },
  }));
  await writeFile(join(config, "tui.json"), JSON.stringify({ plugin: [pathToFileURL(join(dist, "tui.js")).href] }));
  const environment = {
    ...subprocessEnv, COLORTERM: "truecolor",
    XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
    OPENCODE_CONFIG_DIR: config,
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1",
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1",
  };
  const launch = ["env", "-i", ...Object.entries(environment).map(([key, value]) => `${key}=${value}`), opencode!].map(shellQuote).join(" ");
  await command(["new-session", "-d", "-s", "verify", "-x", "140", "-y", "48", "-c", project, `exec ${launch}`]);
  await waitFor("OpenCode startup", value => value.includes("Fixture Reviewer") && value.includes("commands"), 90_000);

  await settings("workflow_config");
  await keys("Escape");
  await waitFor("settings to close", value => !value.includes("Workflow configuration ("));
  await settings("workflow-config");
  passed("Both slash spellings open native settings without submitting a prompt");

  await choose("Connected providers and model pool");
  await waitFor("connected provider list", value => value.includes("Connected providers") && value.includes("Local Fixture Connection") && value.includes("Second Fixture Connection"));
  assert(!screen.includes("Disabled Fixture Connection"));
  await writeFile(join(root, "connections.txt"), screen);
  await choose("Local Fixture Connection");
  await waitFor("provider model list", value => value.includes("workflow model pool") && value.includes("Fixture Reviewer") && value.includes("Fixture Planner"));
  assert(!screen.includes("Fixture Coder"), "A provider-specific list must not contain another provider's models");
  assert(!screen.includes("Retired Fixture Model"), "Deprecated models must not appear");
  assert(!screen.includes("Hidden Fixture Model"), "Disabled-provider models must not appear");
  await writeFile(join(root, "models.txt"), screen);
  passed("Connected-provider catalog is grouped and excludes unavailable models");

  await choose("Fixture Reviewer");
  await waitFor("selected model to persist", async () => (await patch(projectConfig).catch(() => undefined))?.models?.allowed?.includes("fixture/family/reviewer") === true);
  assert.deepEqual((await patch(projectConfig)).models?.allowed, ["fixture/family/reviewer"]);
  passed("Model toggle persists the exact slash-bearing provider/model ID");

  // Unsupported models may be displayed as disabled rows, but cannot be added.
  await choose("Fixture Text Only");
  await waitFor("non-tool model remains unselected", value => value.includes("Fixture Text Only"));
  assert.deepEqual((await patch(projectConfig)).models?.allowed, ["fixture/family/reviewer"]);
  await keys("Escape");
  await waitFor("model dialog to close", value => !value.includes("workflow model pool"));
  passed("Text-only models cannot be added to the autonomous pool");

  await settings("workflow_config");
  await choose("Default model");
  await waitFor("default model provider list", value => value.includes("Connected providers") && value.includes("default model"));
  await choose("Second Fixture Connection");
  await waitFor("second provider defaults", value => value.includes("default workflow model") && value.includes("Fixture Coder"));
  await choose("Fixture Coder");
  await waitFor("project default persisted", async value => value.includes("Workflow configuration (") && (await patch(projectConfig)).models?.default === "second-fixture/coder");
  passed("Default model selection uses the same connected-provider catalog");

  await choose("Save scope");
  await waitFor("global scope", value => value.includes("Workflow configuration (global)"));
  await choose("Strict model pool");
  await waitFor("global settings persisted", async value => value.includes("Strict model pool: on") && (await patch(globalConfig).catch(() => undefined))?.models?.strict === true);
  assert.equal((await patch(projectConfig)).models?.strict, undefined);
  passed("Global scope saves to the isolated global config without overwriting project settings");

  await keys("Escape");
  await waitFor("settings to close before the live run", value => !value.includes("Workflow configuration ("));
  await ultracode();
  await choose("Enable Ultracode");
  await waitFor("Ultracode enabled for the next session", value => value.includes("on (next session)"));
  await choose("Use configured default");
  await waitFor("Ultracode reset", value => value.includes("off (next session)"));
  await keys("Escape");
  await waitFor("Ultracode controls close", value => !value.includes("Ultracode —"));
  passed("Native Ultracode controls enable and reset session mode without creating a chat");
  await type("/workflow-goals");
  await waitFor("goal controls completion", value => value.includes("View and control workflow goal"));
  await keys("Enter");
  await waitFor("native empty goal controls", value => value.includes("Workflow goal — none") && value.includes("Start a workflow goal"));
  await keys("Escape");
  await waitFor("goal controls close", value => !value.includes("Workflow goal — none"));
  passed("Native goal controls are present without creating a session or model request");
  assert.deepEqual((await patch(projectConfig)).models?.allowed, ["fixture/family/reviewer"], "Later settings must preserve the selected pool and must not add text-only models");
  assert.deepEqual(fixture.requests, [], "Native settings must never make model API requests");
  const database = new Database(join(root, "data", "opencode", "opencode.db"), { readonly: true });
  try {
    const row = database.query("SELECT COUNT(*) AS count FROM session").get() as { count: number };
    assert.equal(row.count, 0, "Native settings must never create chat sessions");
  } finally { database.close(); }
  passed("No chat sessions or model API requests were created");

  fixture.setWorkflowInput({ plan: { summary: "Sidebar live verification", tasks: [
    { id: "inspect", label: "Inspect task", task: "Inspect the isolated sidebar fixture.", reason: "Connected reviewer matches inspection work.", model: "fixture/family/reviewer", dependsOn: [] },
    { id: "verify", label: "Verify task", task: "Verify the inspection result.", reason: "Fresh review checks the dependency result.", model: "fixture/family/reviewer", dependsOn: ["inspect"] },
  ] } });
  await type(`/workflow ${PARENT_MARKER}: run the configured workflow tool once.`);
  await keys("Enter");
  const sidebar = (value: string) => value.split("\n").map(line => Array.from(line).slice(90).join("")).join("\n");
  await waitFor("live workflow sidebar", value => sidebar(value).includes("Workflows") && sidebar(value).includes("Inspect task"), 45_000);
  assert(!screen.includes("Session workflows"), "Live progress must be visible without opening the workflow dialog");
  await writeFile(join(root, "sidebar-running.txt"), screen);
  assert(!screen.includes("This is an OpenCode /workflow request"), "Internal workflow instructions must not be rendered as the user's task");
  passed("The real OpenCode sidebar shows the active workflow without opening /workflows");
  await waitFor("dependency agent starts in sidebar", value => sidebar(value).includes("1/2 agents finished") && sidebar(value).includes("Verify task"), 25_000);
  await writeFile(join(root, "sidebar-verifying.txt"), screen);
  passed("Live sidebar updates agent progress and dependency execution automatically");
  await waitFor("workflow completes in sidebar", value => sidebar(value).includes("2/2 agents finished") && sidebar(value).includes("completed"), 25_000);
  await writeFile(join(root, "sidebar-completed.txt"), screen);
  assert(fixture.requests.length >= 3, "The live check must execute real OpenCode parent and child sessions through the isolated fixture");
  passed("Live sidebar keeps the real completed result and exact connected model visible");

  await newSession();
  const stage = (id: string) => ({ plan: { summary: `Automatic ${id}`, tasks: [
    { id, label: id, task: `Complete the isolated ${id} stage`, reason: "One focused stage on the selected connected model", model: "fixture/family/reviewer", dependsOn: [] },
  ] } });
  fixture.setAutomaticStages([stage("implementation"), stage("verification")]);
  await type(`${PARENT_MARKER}: ultracode implement and verify this fixture`);
  await keys("Enter");
  await waitFor("keyword starts implementation without a slash command", value => sidebar(value).includes("Automatic implementation"), 45_000);
  assert(!screen.includes("Ultracode workflow assistance is opted in"), "Automatic setup must remain hidden");
  passed("Human terminal keyword starts a workflow without /workflow or a visible script");
  await waitFor("automatic verification starts", value => sidebar(value).includes("Automatic verification"), 30_000);
  await waitFor("automatic stages finish", value => value.includes("Requested work verified complete."), 30_000);
  passed("The real terminal continues from implementation to verification without another user prompt");

  await newSession();
  await ultracode();
  await choose("Enable Ultracode");
  await waitFor("session mode is enabled", value => value.includes("on (next session)"));
  await keys("Escape");
  await waitFor("Ultracode closes before task", value => !value.includes("Ultracode —"));
  fixture.setAutomaticStages([stage("session-mode")]);
  await type(`${PARENT_MARKER}: implement the fixture using the current session setting`);
  await keys("Enter");
  await waitFor("session mode handles ordinary task", value => sidebar(value).includes("Automatic session-mode"), 30_000);
  await waitFor("session task completes", value => value.includes("Requested work verified complete."), 30_000);
  passed("Session Ultracode mode automatically handles a plain task without the keyword");

  await newSession();
  await type("/workflow-dismiss");
  await waitFor("dismiss command completion", value => value.includes("Dismiss or restore workflow trigger"));
  await keys("Enter");
  await type(`${PARENT_MARKER}: ultracode this trigger is dismissed`);
  await keys("Enter");
  await waitFor("dismissed keyword gets direct answer", value => value.includes("Direct answer; no workflow needed."), 30_000);
  assert(!sidebar(screen).includes("Automatic session-mode"));
  passed("Per-prompt dismissal suppresses the keyword in a real terminal submission");

  await newSession();
  await ultracode(); await choose("Enable Ultracode");
  await waitFor("goal session enables Ultracode", value => value.includes("on (next session)"));
  await keys("Escape"); await waitFor("goal session controls close", value => !value.includes("Ultracode —"));
  const criterion = "The goal fixture passes its acceptance check";
  await writeFile(join(project, "goal-proof.txt"), "PASS: isolated goal acceptance fixture");
  fixture.setAutomaticStages();
  fixture.setToolCall("workflow_goal", { action: "start", objective: "Finish and verify the isolated goal fixture" });
  fixture.setStructuredResult((_schema, prompt) => {
    if (prompt.includes("WORKFLOW_GOAL_CONTRACT")) return { criteria: [criterion], summary: "Define goal fixture acceptance" };
    if (prompt.includes("WORKFLOW_GOAL_PLAN")) return { decision: "workflow", summary: "Complete one fixture stage", reason: "One criterion remains", plan: {
      summary: "Goal fixture work", tasks: [{ id: "goalwork", label: "Goal fixture work", task: "Inspect the isolated goal fixture", reason: "Use the configured review model", model: "fixture/family/reviewer", dependsOn: [] }],
    } };
    const cycle = Number(/"cycle":(\d+)/.exec(prompt)?.[1] ?? 0);
    return { summary: cycle ? "Goal fixture verified" : "Work remains", blocker: "", evidence: [
      { criterion, met: cycle >= 1, method: "Offline acceptance oracle", observation: cycle ? "PASS" : "UNMET", artifact: "goal-proof.txt" },
    ] };
  });
  await type(`/workflow-goal ${PARENT_MARKER}: complete the goal fixture`);
  await keys("Enter");
  await waitFor("goal sidebar starts", value => sidebar(value).includes("Workflow goal") && sidebar(value).includes("defining"), 45_000);
  await writeFile(join(root, "goal-running.txt"), screen);
  passed("The singular goal command accepts inline arguments and shows a real running supervisor");
  await type("/workflow-goals");
  await waitFor("live goal controls completion", value => value.includes("View and control workflow goal"));
  await keys("Enter");
  await waitFor("live goal native controls", value => value.includes("Pause goal") && value.includes("Stop goal permanently"));
  await choose("Pause goal");
  await waitFor("goal paused persistently", value => value.includes("Workflow goal — paused"));
  await choose("Resume goal");
  await waitFor("goal resumed persistently", value => value.includes("Workflow goal — active"));
  await keys("Escape"); await waitFor("goal dialog closes", value => !value.includes("Workflow goal — active"));
  passed("Native pause and resume control the live supervisor without a chat tool call");
  await waitFor("goal verified after resumed work", value => sidebar(value).includes("completed") && sidebar(value).includes("1/1 checks"), 90_000);
  await writeFile(join(root, "goal-completed.txt"), screen);
  passed("Goal mode and Ultracode coexist through resumed execution and independent acceptance");
  success = true;
  console.log(`\n${checks} real OpenCode TUI checks passed.`);
} catch (error) {
  await writeFile(join(root, "failure-screen.txt"), screen).catch(() => {});
  console.error(`Real TUI artifacts retained at ${root}`);
  console.error((await readFile(log, "utf8").catch(() => "")).slice(-6000));
  throw error;
} finally {
  await command(["kill-server"], true).catch(() => {});
  fixture?.stop();
  if (success) await rm(root, { recursive: true, force: true });
}
