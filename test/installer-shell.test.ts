import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "jsonc-parser";

const repository = resolve(import.meta.dir, "..");
const temporaryDirectories: string[] = [];

// Keep all installer filesystem changes in a fixture. Only Bun's JS evaluation
// and the real config helper run normally; downloads and builds are simulated.
const stub = String.raw`
const { basename, join } = require("node:path");
const { appendFileSync, copyFileSync, mkdirSync, symlinkSync, writeFileSync } = require("node:fs");
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
const fail = process.env.WORKFLOW_TEST_FAIL;
function event(name) { appendFileSync(process.env.WORKFLOW_TEST_EVENTS, name + "\n"); }
if (command === "gh") {
  if (args[0] === "api") {
    event("api");
    // A failed HTTP download may still have emitted a prefix of its body.
    console.log('touch "$WORKFLOW_TEST_PARTIAL_EXECUTED"');
    process.exit(17);
  }
  if (args[0] === "auth" && args[1] === "status") {
    event("auth");
    process.exit(fail === "auth" ? 1 : 0);
  }
  if (args[0] === "repo" && args[1] === "clone") {
    event("clone");
    if (fail === "clone") process.exit(1);
    if (args[2] !== "github.com/pacmm255/opencode-workflow-engine") throw new Error("Unexpected repository");
    const release = args[3];
    mkdirSync(join(release, "scripts"), { recursive: true });
    copyFileSync(join(process.env.WORKFLOW_TEST_REPOSITORY, "scripts", "configure.ts"), join(release, "scripts", "configure.ts"));
    symlinkSync(join(process.env.WORKFLOW_TEST_REPOSITORY, "node_modules"), join(release, "node_modules"), "dir");
    process.exit(0);
  }
  throw new Error("Unexpected gh call: " + args.join(" "));
}
if (command === "opencode") {
  if (args.join(" ") !== "--version") throw new Error("Unexpected opencode call");
  console.log("1.18.29");
  process.exit(0);
}
if (command === "git") {
  event("revision");
  if (args[0] !== "-C" || args.slice(2).join(" ") !== "rev-parse --short HEAD") throw new Error("Unexpected git call");
  console.log("abcdef0");
  process.exit(0);
}
if (command === "bun") {
  if (args[0] === "install") {
    event("dependencies");
    if (args[1] !== "--frozen-lockfile") throw new Error("Unlocked dependencies");
    process.exit(fail === "dependencies" ? 1 : 0);
  }
  if (args[0] === "run" && args[1] === "build") {
    event("build");
    if (fail === "build") process.exit(1);
    mkdirSync("dist/skills/workflow-authoring", { recursive: true });
    for (const entry of ["server", "tui", "worker"]) writeFileSync("dist/" + entry + ".js", "export {};\n");
    writeFileSync("dist/skills/workflow-authoring/SKILL.md", "Authoring reference fixture\n");
    process.exit(0);
  }
  if (args[0] === "run" && args[1].endsWith("/scripts/configure.ts")) {
    event(args.includes("--check") ? "check" : "configure");
    if (args.includes("--check") && fail === "preflight") process.exit(1);
  }
  const result = Bun.spawnSync([process.env.WORKFLOW_TEST_BUN, ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env });
  process.exit(result.exitCode);
}
throw new Error("Unexpected test stub: " + command);
`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "workflow-installer-shell-"));
  temporaryDirectories.push(root);
  const bin = join(root, "bin");
  await mkdir(bin);
  for (const command of ["bun", "gh", "git", "opencode"]) {
    const file = join(bin, command);
    await writeFile(file, `#!${process.execPath}\n${stub}`);
    await chmod(file, 0o755);
  }
  const installRoot = join(root, "installation with spaces");
  const configDir = join(root, "configuration with spaces");
  const events = join(root, "events");
  const env = {
    PATH: `${bin}${delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
    WORKFLOW_INSTALL_ROOT: installRoot,
    WORKFLOW_CONFIG_DIR: configDir,
    WORKFLOW_TEST_REPOSITORY: repository,
    WORKFLOW_TEST_BUN: process.execPath,
    WORKFLOW_TEST_EVENTS: events,
    WORKFLOW_TEST_PARTIAL_EXECUTED: join(root, "partial-download-was-executed"),
  };
  return { root, installRoot, configDir, events, env };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function run(f: Fixture, fail?: string, command?: string) {
  const child = Bun.spawn(command ? ["bash", "-c", command] : ["bash", join(repository, "install.sh")], {
    cwd: f.root,
    env: { ...f.env, ...(fail ? { WORKFLOW_TEST_FAIL: fail } : {}) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { output: `${stdout}${stderr}`, exitCode };
}

async function priorInstallation(f: Fixture) {
  const release = join(f.installRoot, "releases", "release.PREVIOUS");
  await mkdir(release, { recursive: true });
  await writeFile(join(f.installRoot, ".workflow-engine-owner"), "pacmm255/opencode-workflow-engine\n");
  await writeFile(join(release, "user-edits"), "keep my changes\n");
  await symlink(release, join(f.installRoot, "current"));
  return release;
}

async function expectUnlocked(f: Fixture) {
  expect((await readdir(f.installRoot)).includes(".install-lock")).toBe(false);
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("one-line installer shell", () => {
  test("installs both real config entries after a complete simulated private clone and build", async () => {
    const f = await fixture();
    const result = await run(f);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Installed OpenCode Workflow Engine (abcdef0)");
    const current = join(f.installRoot, "current");
    const release = await readlink(current);
    expect(release.startsWith(join(f.installRoot, "releases", "release."))).toBe(true);
    expect(await readFile(join(current, "dist", "worker.js"), "utf8")).toBe("export {};\n");
    for (const [file, entry] of [["opencode.jsonc", "server"], ["tui.jsonc", "tui"]]) {
      const config = parse(await readFile(join(f.configDir, file!), "utf8"));
      expect(config.plugin).toEqual([pathToFileURL(join(current, "dist", `${entry}.js`)).href]);
    }
    expect((await readFile(f.events, "utf8")).trim().split("\n")).toEqual(["auth", "clone", "dependencies", "build", "check", "configure", "revision"]);
    await expectUnlocked(f);
  }, 20_000);

  test.each(["auth", "clone", "dependencies", "build", "preflight"])("%s failure preserves the previous release and cleans up its lock", async failure => {
    const f = await fixture();
    const prior = await priorInstallation(f);
    const result = await run(f, failure);
    expect(result.exitCode).not.toBe(0);
    expect(await readlink(join(f.installRoot, "current"))).toBe(prior);
    expect(await readFile(join(prior, "user-edits"), "utf8")).toBe("keep my changes\n");
    await expect(lstat(f.configDir)).rejects.toThrow();
    await expectUnlocked(f);
  }, 20_000);

  test("actual invalid TUI configuration prevents promotion and leaves server settings unchanged", async () => {
    const f = await fixture();
    const prior = await priorInstallation(f);
    await mkdir(f.configDir);
    const server = '{ "model": "provider/model" }\n';
    await writeFile(join(f.configDir, "opencode.json"), server);
    await writeFile(join(f.configDir, "tui.jsonc"), '{ "plugin": false }');
    const result = await run(f);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("Invalid plugin array");
    expect(await readlink(join(f.installRoot, "current"))).toBe(prior);
    expect(await readFile(join(f.configDir, "opencode.json"), "utf8")).toBe(server);
    expect(await readdir(f.configDir)).toEqual(["opencode.json", "tui.jsonc"]);
    await expectUnlocked(f);
  }, 20_000);

  test("reinstallation retains old builds and edits without duplicating configuration", async () => {
    const f = await fixture();
    expect((await run(f)).exitCode).toBe(0);
    const prior = await readlink(join(f.installRoot, "current"));
    await writeFile(join(prior, "user-edits"), "preserve old build\n");
    const original = await readFile(join(f.configDir, "opencode.jsonc"), "utf8");
    const withComment = `// my unchanged preferences\n${original}`;
    await writeFile(join(f.configDir, "opencode.jsonc"), withComment);
    const tuiOriginal = await readFile(join(f.configDir, "tui.jsonc"), "utf8");
    expect((await run(f)).exitCode).toBe(0);
    expect(await readlink(join(f.installRoot, "current"))).not.toBe(prior);
    expect(await readFile(join(prior, "user-edits"), "utf8")).toBe("preserve old build\n");
    expect(await readFile(join(f.configDir, "opencode.jsonc"), "utf8")).toBe(withComment);
    expect(await readFile(join(f.configDir, "tui.jsonc"), "utf8")).toBe(tuiOriginal);
    expect((await readdir(join(f.installRoot, "releases"))).length).toBe(2);
    expect(await readdir(f.configDir)).toEqual(["opencode.jsonc", "tui.jsonc"]);
    await expectUnlocked(f);
  }, 20_000);

  test("refuses an unmanaged existing installation root", async () => {
    const f = await fixture();
    await mkdir(f.installRoot);
    await writeFile(join(f.installRoot, "user-file"), "untouched");
    const result = await run(f);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("not managed");
    expect(await readdir(f.installRoot)).toEqual(["user-file"]);
    expect(await readFile(join(f.installRoot, "user-file"), "utf8")).toBe("untouched");
  }, 20_000);

  test.each(["file", "outside-link", "release-link"])("refuses an unmanaged current %s without modifying config", async kind => {
    const f = await fixture();
    await mkdir(join(f.installRoot, "releases"), { recursive: true });
    await writeFile(join(f.installRoot, ".workflow-engine-owner"), "pacmm255/opencode-workflow-engine\n");
    const current = join(f.installRoot, "current");
    const outside = join(f.root, "outside");
    await mkdir(outside);
    if (kind === "file") await writeFile(current, "keep this file");
    else if (kind === "outside-link") await symlink(outside, current);
    else {
      const releaseLink = join(f.installRoot, "releases", "release.EXTERNAL");
      await symlink(outside, releaseLink);
      await symlink(releaseLink, current);
    }
    const result = await run(f);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toMatch(/unrelated current|unmanaged current|managed release/);
    if (kind === "file") expect(await readFile(current, "utf8")).toBe("keep this file");
    else expect(await readlink(current)).toBe(kind === "outside-link" ? outside : join(f.installRoot, "releases", "release.EXTERNAL"));
    expect(await readdir(outside)).toEqual([]);
    await expect(lstat(f.configDir)).rejects.toThrow();
    await expectUnlocked(f);
  }, 20_000);

  test("does not remove another installer's existing lock", async () => {
    const f = await fixture();
    const prior = await priorInstallation(f);
    const lock = join(f.installRoot, ".install-lock");
    await mkdir(lock);
    const result = await run(f);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("Another installation");
    expect((await lstat(lock)).isDirectory()).toBe(true);
    expect(await readlink(join(f.installRoot, "current"))).toBe(prior);
  }, 20_000);

  test("README command never executes a partial body from a failed GitHub download", async () => {
    const f = await fixture();
    const readme = await readFile(join(repository, "README.md"), "utf8");
    const command = readme.match(/```sh\n([^\n]+)\n```/)?.[1];
    expect(command).toContain("gh api");
    const result = await run(f, undefined, command!);
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(f.events, "utf8")).toBe("api\n");
    await expect(lstat(f.env.WORKFLOW_TEST_PARTIAL_EXECUTED)).rejects.toThrow();
    await expect(lstat(f.installRoot)).rejects.toThrow();
  }, 20_000);
});
