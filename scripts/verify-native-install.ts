import assert from "node:assert/strict";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2";
import type { RunState } from "../src/core/run/state.ts";
import { PARENT_MARKER, startModelFixture } from "../e2e/fixture.ts";

/**
 * Exercise OpenCode's own plugin installer against source-only package files.
 * Local-package dependencies are shared by symlink; the Git installation uses
 * OpenCode's real dependency installation and Git package preparation path.
 * dist is never copied or committed into the temporary source repository.
 * All config, auth, cache, model requests, sessions, and runs are isolated.
 * This verifies local and git+file package loading, not private GitHub authentication.
 */
const opencode = Bun.which("opencode");
if (!opencode) throw new Error("Native installation verification requires OpenCode on PATH.");
const repository = resolve(import.meta.dir, "..");
const root = await mkdtemp(join(tmpdir(), "workflow-native-install-"));
const source = join(root, "source-plugin");
const environmentRoot = join(root, "environment");
const config = join(environmentRoot, "config", "opencode");
const cache = join(environmentRoot, "cache");
const data = join(environmentRoot, "data");
const project = join(root, "local-project");
const globalProject = join(root, "global-project");
const runs = join(data, "opencode", "workflow", "runs");
const serverLog = join(root, "server.log");
const model = { providerID: "fixture", modelID: "test" };
const environment = {
  PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", TERM: "dumb",
  XDG_CONFIG_HOME: join(environmentRoot, "config"), XDG_DATA_HOME: data,
  XDG_CACHE_HOME: cache, XDG_STATE_HOME: join(environmentRoot, "state"),
  OPENCODE_CONFIG_DIR: config,
  OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1",
  OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1",
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
};
let fixture: ReturnType<typeof startModelFixture> | undefined;
let server: Bun.Subprocess | undefined;
let client: OpencodeClient;
let checks = 0;
let success = false;

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

async function command(args: string[], cwd: string, timeout = 90_000): Promise<string> {
  const child = Bun.spawn(args, { cwd, env: environment, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`${args[0]} ${args[1] ?? ""} failed (${code}): ${stderr || stdout}`);
    return stdout + stderr;
  } finally { clearTimeout(timer); }
}

async function poll<T>(description: string, check: () => Promise<T | undefined | false>, timeout = 45_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result !== undefined && result !== false) return result;
    if (server && server.exitCode !== null) throw new Error(`OpenCode exited (${server.exitCode}).`);
    await Bun.sleep(150);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function passed(description: string): void {
  checks++;
  console.log(`✓ ${description}`);
}

async function registered(directory: string, target = source): Promise<void> {
  for (const name of ["opencode", "tui"]) {
    const file = join(directory, `${name}.json`);
    const content = JSON.parse(await readFile(file, "utf8")) as { plugin?: Array<string | [string, unknown]> };
    const entries = (content.plugin ?? []).map(entry => Array.isArray(entry) ? entry[0] : entry);
    const matches = entries.filter(entry => {
      if (target.startsWith("git+")) return entry === target;
      const path = entry.startsWith("file://") ? fileURLToPath(entry) : entry;
      return isAbsolute(path) && resolve(path) === target;
    });
    assert.equal(matches.length, 1, `${name}.json must register the requested native package exactly once`);
    assert(!entries.some(entry => entry.includes("dist/")), "Native registration must not point to a prebuilt file");
  }
}

async function launch(input: Record<string, unknown>, tool = "workflow"): Promise<string> {
  fixture!.setToolCall(tool, input);
  const { data: session } = await client.session.create({
    directory: globalProject, title: `Native source verification: ${tool}`, agent: "build",
    model: { id: model.modelID, providerID: model.providerID },
  }, { throwOnError: true, signal: AbortSignal.timeout(15_000) });
  await client.session.promptAsync({ directory: globalProject, sessionID: session.id, agent: "build", model,
    parts: [{ type: "text", text: `${PARENT_MARKER}: execute the configured ${tool} tool once.` }],
  }, { throwOnError: true, signal: AbortSignal.timeout(15_000) });
  return session.id;
}

async function toolResult(sessionID: string, tool = "workflow"): Promise<string> {
  return poll(`${tool} result`, async () => {
    const { data: messages } = await client.session.messages({ directory: globalProject, sessionID }, {
      throwOnError: true, signal: AbortSignal.timeout(10_000),
    });
    for (const message of messages) {
      for (const part of message.parts) if (part.type === "tool" && part.tool === tool) {
        if (part.state.status === "error") throw new Error(`${tool} failed: ${part.state.error}`);
        if (part.state.status === "completed") return part.state.output;
      }
      if (message.info.role === "assistant" && message.info.error) throw new Error(`Parent failed: ${JSON.stringify(message.info.error)}`);
    }
    return undefined;
  });
}

async function parentIdle(sessionID: string): Promise<void> {
  await poll("completed parent turn", async () => {
    const [{ data: statuses }, { data: messages }] = await Promise.all([
      client.session.status({ directory: globalProject }, { throwOnError: true, signal: AbortSignal.timeout(10_000) }),
      client.session.messages({ directory: globalProject, sessionID }, { throwOnError: true, signal: AbortSignal.timeout(10_000) }),
    ]);
    const last = messages.at(-1)?.info;
    return (!statuses[sessionID] || statuses[sessionID]?.type === "idle")
      && last?.role === "assistant" && last.time.completed !== undefined && last.finish === "stop";
  });
}

async function runFor(sessionID: string): Promise<RunState> {
  return poll("persisted completed workflow", async () => {
    for (const id of await readdir(runs).catch(() => [])) {
      const run = await readFile(join(runs, id, "run.json"), "utf8").then(text => JSON.parse(text) as RunState).catch(() => undefined);
      if (run?.sessionID === sessionID && run.status !== "running") return run;
    }
    return undefined;
  });
}

try {
  for (const directory of [source, config, data, cache, join(environmentRoot, "state"), project, globalProject]) {
    await mkdir(directory, { recursive: true });
  }
  // A dependency symlink keeps this offline check focused on OpenCode's native
  // package/TypeScript loading, rather than another registry installation test.
  await access(join(repository, "node_modules", "@opencode-ai", "plugin"));
  for (const item of ["package.json", "src", "workflows"]) await cp(join(repository, item), join(source, item), { recursive: true });
  await symlink(join(repository, "node_modules"), join(source, "node_modules"), "dir");
  assert.equal(await exists(join(source, "dist")), false);
  const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  for (const kind of ["server", "tui"]) {
    const entry = manifest.exports?.[`./${kind}`];
    assert.equal(typeof entry === "string" ? entry : entry?.import, `./src/${kind}.ts`, "Native package exports must load source without a build");
  }
  for (const lifecycle of ["build", "prepare", "prepack", "preinstall", "install", "postinstall"]) {
    assert.equal(manifest.scripts?.[lifecycle], undefined, `${lifecycle} must not trigger npm Git dependency preparation`);
  }
  assert.equal(manifest.workspaces, undefined, "Workspaces must not trigger npm Git dependency preparation");
  passed("Source-only package has TypeScript server/TUI exports and no dist directory");

  for (const directory of [project, globalProject]) await command(["git", "init", "-q"], directory);
  await command([opencode, "plugin", source], project);
  await registered(join(project, ".opencode"));
  assert.equal(await exists(join(config, "opencode.json")), false, "Project installation must not write global plugin configuration");
  passed("opencode plugin registers both native entrypoints in project configuration");
  await command([opencode, "plugin", source], project);
  await registered(join(project, ".opencode"));
  passed("Repeating project installation does not duplicate plugin entries");

  await command([opencode, "plugin", source, "-g"], globalProject);
  await registered(config);
  assert.equal(await exists(join(globalProject, ".opencode", "opencode.json")), false, "Global installation must not write project plugin configuration");
  passed("opencode plugin -g registers both native entrypoints globally");
  await command([opencode, "plugin", source, "-g"], globalProject);
  await registered(config);
  passed("Repeating global installation does not duplicate plugin entries");

  // Local directory installation alone never exercises Pacote's Git packing
  // branch. Commit exactly the publishable source files, excluding the linked
  // dependencies, then install this fresh Git dependency with OpenCode itself.
  await command(["git", "init", "-q"], source);
  await command(["git", "add", "--", "package.json", "src", "workflows"], source);
  await command(["git", "-c", "user.name=Workflow Native Tests", "-c", "user.email=workflow-native-tests@example.invalid",
    "commit", "-qm", "Source-only native installation fixture"], source);
  const revision = (await command(["git", "rev-parse", "HEAD"], source)).trim();
  const gitSpec = `git+${pathToFileURL(source).href}#${revision}`;
  const committed = (await command(["git", "ls-files"], source)).split("\n");
  assert(!committed.some(file => file.startsWith("dist/") || file.startsWith("node_modules/")));
  // Remove only our own temporary registration so source-path loading cannot
  // conceal a broken Git install when the subsequent real server starts.
  for (const name of ["opencode", "tui"]) {
    const file = join(config, `${name}.json`);
    const prior = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...prior, plugin: [] }));
  }
  await command([opencode, "plugin", gitSpec, "-g"], globalProject, 150_000);
  await registered(config, gitSpec);
  passed("Native git+file installation packs source and installs dependencies without build or preparation hooks");

  fixture = startModelFixture({ childText: prompt => `native source child:${prompt}` });
  const configFile = join(config, "opencode.json");
  const installed = JSON.parse(await readFile(configFile, "utf8"));
  await writeFile(configFile, JSON.stringify({ ...installed,
    enabled_providers: ["fixture"], model: "fixture/test", small_model: "fixture/test",
    share: "disabled", autoupdate: false, permission: "allow",
    provider: { fixture: { npm: "@ai-sdk/openai-compatible", name: "Native install fixture",
      options: { baseURL: `${fixture.url}/v1`, apiKey: "isolated-fixture-only" },
      models: { test: { name: "Native source model", limit: { context: 32_000, output: 4096 }, cost: { input: 0, output: 0 }, tool_call: true } },
    } },
  }));
  await mkdir(join(globalProject, ".opencode"), { recursive: true });
  await writeFile(join(globalProject, ".opencode", "workflow.json"), JSON.stringify({
    limits: { maxConcurrency: 3, agentTimeoutMs: 20_000, runTimeoutMs: 45_000 }, defaults: { retries: 0 }, ui: { toasts: false },
  }));
  const reserved = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
  const port = reserved.port!;
  await reserved.stop(true);
  server = Bun.spawn([opencode, "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: globalProject, env: environment, stdout: Bun.file(serverLog), stderr: Bun.file(serverLog),
  });
  client = createOpencodeClient({ baseUrl: `http://127.0.0.1:${port}` });
  await poll("OpenCode startup", async () => {
    try { return (await client.global.health({ throwOnError: true, signal: AbortSignal.timeout(3000) })).data.healthy; }
    catch { return false; }
  }, 60_000);
  const { data: commands } = await client.command.list({ directory: globalProject }, {
    throwOnError: true, signal: AbortSignal.timeout(60_000),
  });
  assert(commands.some(command => command.name === "workflow"), "Git-installed source package must load its server commands");
  passed("Real OpenCode server loads the Git-installed TypeScript package without a build");

  const { data: skills } = await client.app.skills({ directory: globalProject }, { throwOnError: true, signal: AbortSignal.timeout(15_000) });
  const authoring = skills.find(skill => skill.name === "workflow-authoring");
  assert(authoring, "Native source loading must register the authoring skill without a build");
  assert(authoring.content.includes("pipeline"), "Discovered authoring skill must include the runtime reference");
  const skillLocation = authoring.location.startsWith("file://") ? fileURLToPath(authoring.location) : authoring.location;
  const cacheRelative = relative(cache, skillLocation);
  assert(cacheRelative !== ".." && !cacheRelative.startsWith(`..${sep}`) && !isAbsolute(cacheRelative), "Generated authoring skill must stay inside isolated XDG cache");
  assert((await readFile(skillLocation, "utf8")).includes("workflow-authoring"));
  passed("Authoring skill is generated, readable, and discovered inside isolated XDG cache");

  const inlineSession = await launch({ script: "return await agent('source-worker-check')" });
  assert((await toolResult(inlineSession)).includes("completed"));
  const inline = await runFor(inlineSession);
  assert.equal(inline.status, "completed");
  assert.equal(inline.result, "native source child:source-worker-check");
  const { data: children } = await client.session.children({ directory: globalProject, sessionID: inlineSession }, { throwOnError: true, signal: AbortSignal.timeout(10_000) });
  assert.equal(children.length, 1, "Native TS worker must dispatch a real OpenCode child session");
  await parentIdle(inlineSession);
  passed("Native TypeScript worker executes an inline workflow with a real child session");

  const savedSession = await launch({ name: "review-changes", args: { task: "Verify the isolated source-only installation." } });
  assert((await toolResult(savedSession)).includes("completed"));
  const saved = await runFor(savedSession);
  assert.equal(saved.status, "completed");
  assert.equal(saved.agents.length, 6);
  assert(saved.agents.every(agent => agent.status === "completed"));
  assert(Array.isArray(saved.result) && saved.result.length === 3);
  assert.equal((await client.session.children({ directory: globalProject, sessionID: savedSession }, { throwOnError: true, signal: AbortSignal.timeout(10_000) })).data.length, 6);
  await parentIdle(savedSession);
  passed("Saved review-changes workflow resolves from source and executes all six real children");
  assert.equal(await exists(join(source, "dist")), false, "Native source execution must not rely on a generated build");
  assert(fixture.requests.length > 0, "Workflow verification must execute model fixture requests");
  await registered(config, gitSpec);
  success = true;
  console.log(`\n${checks} native installation checks passed; no dist build, user configuration, or paid model calls used.`);
} catch (error) {
  console.error(`Native install verification artifacts retained at ${root}`);
  console.error((await readFile(serverLog, "utf8").catch(() => "")).slice(-12_000));
  throw error;
} finally {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    const exited = await Promise.race([server.exited.then(() => true), Bun.sleep(5000).then(() => false)]);
    if (!exited) { server.kill("SIGKILL"); await server.exited; }
  }
  fixture?.stop();
  if (success) await rm(root, { recursive: true, force: true });
}
