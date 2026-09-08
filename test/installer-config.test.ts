import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "jsonc-parser";
import { configureInstallation } from "../scripts/configure.ts";

const temporaryDirectories: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "workflow-installer-config-"));
  temporaryDirectories.push(root);
  const configDir = join(root, "config with spaces");
  const pluginDir = join(root, "plugin # with spaces");
  await mkdir(configDir);
  return { root, configDir, pluginDir };
}
afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function read(configDir: string, name: string) {
  return parse(await readFile(join(configDir, name), "utf8")) as Record<string, unknown>;
}

describe("installer configuration registration", () => {
  test("creates both configurations with escaped absolute URLs and private modes", async () => {
    const options = await fixture();
    await configureInstallation(options);
    expect((await read(options.configDir, "opencode.jsonc")).plugin).toEqual([pathToFileURL(join(options.pluginDir, "dist/server.js")).href]);
    expect((await read(options.configDir, "tui.jsonc")).plugin).toEqual([pathToFileURL(join(options.pluginDir, "dist/tui.js")).href]);
    expect(await readdir(options.configDir)).toEqual(["opencode.jsonc", "tui.jsonc"]);
    expect((await lstat(join(options.configDir, "opencode.jsonc"))).mode & 0o777).toBe(0o600);
  });

  test("preserves JSONC comments, unrelated settings, tuples, CRLF, modes, and backups", async () => {
    const options = await fixture();
    const original = '{\r\n\t// keep this setting\r\n\t"model": "provider/model",\r\n\t"plugin": [\r\n\t\t// keep plugin options\r\n\t\t["existing-plugin", { "enabled": true }],\r\n\t],\r\n}\r\n';
    const file = join(options.configDir, "opencode.jsonc");
    await writeFile(file, original);
    await chmod(file, 0o640);
    await configureInstallation(options);
    const updated = await readFile(file, "utf8");
    expect(updated).toContain("// keep this setting");
    expect(updated).toContain("// keep plugin options");
    expect(updated).toContain('["existing-plugin", { "enabled": true }]');
    expect(updated.replaceAll("\r\n", "")).not.toContain("\n");
    expect((await read(options.configDir, "opencode.jsonc")).model).toBe("provider/model");
    expect((await lstat(file)).mode & 0o777).toBe(0o640);
    const backup = (await readdir(options.configDir)).find(name => name.startsWith("opencode.jsonc.workflow-engine-backup-"))!;
    expect(await readFile(join(options.configDir, backup), "utf8")).toBe(original);
    expect((await lstat(join(options.configDir, backup))).mode & 0o777).toBe(0o640);
  });

  test("reinstallation is byte-for-byte idempotent and creates no additional backups", async () => {
    const options = await fixture();
    await writeFile(join(options.configDir, "opencode.json"), '{ "plugin": ["existing"] }\n');
    await configureInstallation(options);
    const names = await readdir(options.configDir);
    const before = await Promise.all(names.map(name => readFile(join(options.configDir, name), "utf8")));
    await configureInstallation(options);
    expect(await readdir(options.configDir)).toEqual(names);
    expect(await Promise.all(names.map(name => readFile(join(options.configDir, name), "utf8")))).toEqual(before);
  });

  test("patches a lower-priority winning server array without masking its plugins", async () => {
    const options = await fixture();
    await writeFile(join(options.configDir, "config.json"), '{ "plugin": ["legacy-plugin"] }');
    await writeFile(join(options.configDir, "opencode.json"), '{ "plugin": ["winning-plugin"] }');
    const upper = '{\n  // no plugin override\n  "model": "provider/model"\n}\n';
    await writeFile(join(options.configDir, "opencode.jsonc"), upper);
    await configureInstallation(options);
    expect((await read(options.configDir, "opencode.json")).plugin).toEqual(["winning-plugin", pathToFileURL(join(options.pluginDir, "dist/server.js")).href]);
    expect((await read(options.configDir, "config.json")).plugin).toEqual(["legacy-plugin"]);
    expect(await readFile(join(options.configDir, "opencode.jsonc"), "utf8")).toBe(upper);
  });

  test("respects an explicitly empty highest-priority server array", async () => {
    const options = await fixture();
    await writeFile(join(options.configDir, "opencode.json"), '{ "plugin": ["lower-plugin"] }');
    await writeFile(join(options.configDir, "opencode.jsonc"), '{ "plugin": [] }');
    await configureInstallation(options);
    expect((await read(options.configDir, "opencode.jsonc")).plugin).toEqual([pathToFileURL(join(options.pluginDir, "dist/server.js")).href]);
    expect((await read(options.configDir, "opencode.json")).plugin).toEqual(["lower-plugin"]);
  });

  test("preserves existing server and lower-layer TUI tuples without duplicating entries", async () => {
    const options = await fixture();
    const server = JSON.stringify({ plugin: [[pathToFileURL(join(options.pluginDir, "dist/server.js")).href, { custom: true }]] });
    const tui = JSON.stringify({ plugin: [[pathToFileURL(join(options.pluginDir, "dist/tui.js")).href, { remote: true }]] });
    await writeFile(join(options.configDir, "opencode.json"), server);
    await writeFile(join(options.configDir, "tui.json"), tui);
    await writeFile(join(options.configDir, "tui.jsonc"), '{ "theme": "opencode" }');
    await configureInstallation(options);
    expect(await readFile(join(options.configDir, "opencode.json"), "utf8")).toBe(server);
    expect(await readFile(join(options.configDir, "tui.json"), "utf8")).toBe(tui);
    expect((await read(options.configDir, "tui.jsonc")).plugin).toBeUndefined();
    expect((await readdir(options.configDir)).length).toBe(3);
  });

  test.each([
    '{ "plugin": [ }',
    '[]',
    '{ "plugin": null }',
    '{ "plugin": [42] }',
    '{ "plugin": [["example", false]] }',
    '{ "plugin": [""] }',
    '{ "theme": "first", "theme": "second" }',
  ])("invalid second config prevents all writes: %s", async invalid => {
    const options = await fixture();
    const server = '{ "model": "provider/model" }';
    await writeFile(join(options.configDir, "opencode.json"), server);
    await writeFile(join(options.configDir, "tui.jsonc"), invalid);
    await expect(configureInstallation(options)).rejects.toThrow();
    expect(await readFile(join(options.configDir, "opencode.json"), "utf8")).toBe(server);
    expect(await readdir(options.configDir)).toEqual(["opencode.json", "tui.jsonc"]);
  });

  test("rejects symlink config files without touching their targets or other configs", async () => {
    const options = await fixture();
    const outside = join(options.root, "outside.json");
    await writeFile(outside, "{}");
    await symlink(outside, join(options.configDir, "tui.jsonc"));
    await expect(configureInstallation(options)).rejects.toThrow("non-regular");
    expect(await readFile(outside, "utf8")).toBe("{}");
    expect(await readdir(options.configDir)).toEqual(["tui.jsonc"]);
  });

  test("check mode validates but neither creates directories nor modifies existing files", async () => {
    const options = await fixture();
    const missing = join(options.configDir, "not created");
    await configureInstallation({ ...options, configDir: missing, dryRun: true });
    expect(await readdir(options.configDir)).toEqual([]);
    await writeFile(join(options.configDir, "opencode.jsonc"), "{}\n");
    await configureInstallation({ ...options, dryRun: true });
    expect(await readFile(join(options.configDir, "opencode.jsonc"), "utf8")).toBe("{}\n");
    expect(await readdir(options.configDir)).toEqual(["opencode.jsonc"]);
  });

  test("requires explicit absolute locations", async () => {
    const options = await fixture();
    await expect(configureInstallation({ ...options, configDir: "relative" })).rejects.toThrow("absolute");
    await expect(configureInstallation({ ...options, pluginDir: "relative" })).rejects.toThrow("absolute");
    expect(await readdir(options.configDir)).toEqual([]);
  });
});
