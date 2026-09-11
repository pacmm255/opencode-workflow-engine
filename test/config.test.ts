import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, configPaths, defaultConfig, loadConfig, resetConfig, saveConfig } from "../src/core/config.ts";

const temporaryDirectories: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "workflow-config-test-"));
  temporaryDirectories.push(root);
  return { project: join(root, "project"), global: join(root, "global") };
}
afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("workflow config", () => {
  test("defaults are conservative without overriding explicit project concurrency", async () => {
    expect(defaultConfig.limits.maxConcurrency).toBeGreaterThanOrEqual(1);
    expect(defaultConfig.limits.maxConcurrency).toBeLessThanOrEqual(2);
    const paths = await fixture();
    expect((await saveConfig(paths.project, { limits: { maxConcurrency: 12 } }, "project", paths.global)).limits.maxConcurrency).toBe(12);
  });
  test("missing files yield independent, complete defaults", async () => {
    const paths = await fixture();
    const first = await loadConfig(paths.project, paths.global);
    expect(first).toEqual(defaultConfig);
    first.models.allowed.push("provider/model");
    expect((await loadConfig(paths.project, paths.global)).models.allowed).toEqual([]);
  });

  test("merges global and project fields, alias names, and replaces arrays", async () => {
    const paths = await fixture();
    await saveConfig(paths.project, {
      models: { allowed: ["provider/global"], aliases: { fast: "provider/fast", strong: "provider/strong" }, strict: true },
      limits: { maxConcurrency: 2 },
      defaults: { retries: 3 },
    }, "global", paths.global);
    const merged = await saveConfig(paths.project, {
      models: { allowed: ["provider/project"], aliases: { fast: "provider/project-fast" } },
      limits: { maxAgents: 20 },
      sizeGuideline: null,
    }, "project", paths.global);
    expect(merged.models).toEqual({
      allowed: ["provider/project"], strict: true, default: "session",
      aliases: { fast: "provider/project-fast", strong: "provider/strong" },
    });
    expect(merged.limits.maxConcurrency).toBe(2);
    expect(merged.limits.maxAgents).toBe(20);
    expect(merged.limits.agentTimeoutMs).toBe(defaultConfig.limits.agentTimeoutMs);
    expect(merged.defaults.retries).toBe(3);
    expect(merged.sizeGuideline).toBeNull();
    const persisted = JSON.parse(await readFile(configPaths(paths.project, paths.global).project, "utf8"));
    expect(persisted.limits).toEqual({ maxAgents: 20 });
    expect(persisted.defaults).toBeUndefined();
  });

  test("sequential set preserves prior overrides and cleans temporary files", async () => {
    const paths = await fixture();
    await saveConfig(paths.project, { ui: { toasts: false } }, "project", paths.global);
    await saveConfig(paths.project, { limits: { maxConcurrency: 3 } }, "project", paths.global);
    expect((await loadConfig(paths.project, paths.global)).ui.toasts).toBe(false);
    expect(await readdir(join(paths.project, ".opencode"))).toEqual(["workflow.json"]);
  });

  test("concurrent independent updates do not lose fields", async () => {
    const paths = await fixture();
    await Promise.all([
      saveConfig(paths.project, { limits: { maxConcurrency: 2 } }, "project", paths.global),
      saveConfig(paths.project, { limits: { maxAgents: 10 } }, "project", paths.global),
      saveConfig(paths.project, { ui: { toasts: false } }, "project", paths.global),
      saveConfig(paths.project, { defaults: { retries: 0 } }, "project", paths.global),
    ]);
    const config = await loadConfig(paths.project, paths.global);
    expect(config.limits.maxConcurrency).toBe(2);
    expect(config.limits.maxAgents).toBe(10);
    expect(config.ui.toasts).toBe(false);
    expect(config.defaults.retries).toBe(0);
  });

  test("reset removes only the selected scope and reveals inheritance", async () => {
    const paths = await fixture();
    await saveConfig(paths.project, { sizeGuideline: 8 }, "global", paths.global);
    await saveConfig(paths.project, { sizeGuideline: 4 }, "project", paths.global);
    expect((await resetConfig(paths.project, "project", paths.global)).sizeGuideline).toBe(8);
    expect((await resetConfig(paths.project, "project", paths.global)).sizeGuideline).toBe(8);
    expect((await resetConfig(paths.project, "global", paths.global)).sizeGuideline).toBe(15);
  });

  test.each([
    { limits: { maxConcurrency: 0 } },
    { limits: { maxConcurrency: 1.5 } },
    { limits: { syncTimeoutMs: 2_147_483_648 } },
    { defaults: { retries: -1 } },
    { defaults: { effort: "ultra" } },
    { defaults: { agent: "   " } },
    { models: { allowed: ["bare-model"] } },
    { models: { default: "bare-model" } },
    { models: { aliases: { fast: "unknown" } } },
    { models: { strict: "yes" } },
    { limits: { unknown: 4 } },
    { unknown: true },
    { sizeGuideline: 0 },
  ])("rejects invalid patches without altering persisted config: %j", async (patch) => {
    const paths = await fixture();
    await saveConfig(paths.project, { sizeGuideline: 4 }, "project", paths.global);
    const file = configPaths(paths.project, paths.global).project;
    const before = await readFile(file, "utf8");
    await expect(saveConfig(paths.project, patch as never, "project", paths.global)).rejects.toBeInstanceOf(ConfigError);
    expect(await readFile(file, "utf8")).toBe(before);
  });

  test("invalid existing JSON reports its location and can be reset", async () => {
    const paths = await fixture();
    await mkdir(join(paths.project, ".opencode"), { recursive: true });
    const file = configPaths(paths.project, paths.global).project;
    await writeFile(file, "{ broken");
    await expect(loadConfig(paths.project, paths.global)).rejects.toThrow(file);
    expect(await resetConfig(paths.project, "project", paths.global)).toEqual(defaultConfig);
  });

  test("invalid other scope prevents writes or reset from partly succeeding", async () => {
    const paths = await fixture();
    await saveConfig(paths.project, { sizeGuideline: 4 }, "project", paths.global);
    await mkdir(paths.global, { recursive: true });
    const files = configPaths(paths.project, paths.global);
    await writeFile(files.global, "{ broken");
    const before = await readFile(files.project, "utf8");
    await expect(saveConfig(paths.project, { sizeGuideline: 8 }, "project", paths.global)).rejects.toThrow(files.global);
    expect(await readFile(files.project, "utf8")).toBe(before);
    await expect(resetConfig(paths.project, "project", paths.global)).rejects.toThrow(files.global);
    expect(await readFile(files.project, "utf8")).toBe(before);
  });

  test("invalid scope is rejected", async () => {
    const paths = await fixture();
    await expect(saveConfig(paths.project, {}, "other" as never, paths.global)).rejects.toBeInstanceOf(ConfigError);
    await expect(resetConfig(paths.project, "other" as never, paths.global)).rejects.toBeInstanceOf(ConfigError);
  });
});
