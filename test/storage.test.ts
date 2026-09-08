import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheKey, canonical, Journal, ResumeCache } from "../src/core/run/journal";
import { Semaphore } from "../src/core/run/semaphore";
import { SavedWorkflows } from "../src/core/saved";

const temporary: string[] = [];
async function folder() { const path = await mkdtemp(join(tmpdir(), "workflow-storage-")); temporary.push(path); return path; }
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("durable replay journal", () => {
  test("serializes concurrent appends into intact JSON lines", async () => {
    const path = join(await folder(), "journal.jsonl");
    const journal = new Journal(path);
    await Promise.all(Array.from({ length: 80 }, (_, sequence) => journal.append({ type: "agent.result", sequence, key: "same", value: sequence })));
    expect((await journal.read()).map((entry) => entry.sequence)).toEqual(Array.from({ length: 80 }, (_, index) => index));
    expect((await readFile(path, "utf8")).endsWith("\n")).toBe(true);
  });

  test("ignores only a torn final record, rejecting corrupt complete records", async () => {
    const path = join(await folder(), "journal.jsonl");
    await writeFile(path, '{"type":"run.start"}\n{"type":');
    expect(await new Journal(path).read()).toEqual([{ type: "run.start" }]);
    await writeFile(path, '{"type":"run.start"}\nbroken\n');
    await expect(new Journal(path).read()).rejects.toMatchObject({ name: "ResumeJournalError" });
    await writeFile(path, '{"type":"run.start"}\n{}\n');
    await expect(new Journal(path).read()).rejects.toMatchObject({ name: "ResumeJournalError" });
  });

  test("consumes repeated successes in invocation order, including cached false and null", () => {
    const cache = new ResumeCache([
      { type: "agent.result", sequence: 2, key: "x", value: false },
      { type: "agent.error", sequence: 3, key: "x", value: "bad" },
      { type: "agent.result", sequence: 1, key: "x", value: { result: 1 } },
      { type: "agent.cached", sequence: 4, key: "x", value: null },
    ]);
    expect(cache.take("x")).toEqual({ hit: true, value: { result: 1 } });
    expect(cache.take("missing")).toEqual({ hit: false });
    expect(cache.take("x")).toEqual({ hit: true, value: false });
    expect(cache.take("x")).toEqual({ hit: true, value: null });
    expect(cache.take("x")).toEqual({ hit: false });
  });

  test("cache key ignores cosmetic/retry edits but changes with prompt and semantic options", () => {
    expect(canonical({ b: 1, a: { z: 2, c: 3 } })).toBe(canonical({ a: { c: 3, z: 2 }, b: 1 }));
    const original = cacheKey("review", { label: "first", phase: "A", model: "p/m", timeoutMs: 10, schema: { type: "object", properties: {} } });
    expect(original).toBe(cacheKey("review", { phase: "B", model: "p/m", label: "second", retries: 3, schema: { properties: {}, type: "object" } }));
    expect(original).not.toBe(cacheKey("changed prompt", { model: "p/m" }));
    expect(cacheKey("review", { system: "A" })).not.toBe(cacheKey("review", { system: "B" }));
  });
});

describe("saved workflows", () => {
  test("project shadows global; delete archives then reveals global", async () => {
    const root = await folder();
    const saved = new SavedWorkflows(join(root, "project"), join(root, "global"), join(root, "builtin"));
    await saved.save("review", "return 'global';", "global");
    const project = await saved.save("review", "return 'project';");
    expect(await saved.load({ name: "review" })).toBe("return 'project';");
    expect(await saved.list()).toHaveLength(1);
    const archived = await saved.delete("review");
    expect(await readFile(archived, "utf8")).toBe("return 'project';");
    expect(await saved.load({ name: "review" })).toBe("return 'global';");
    expect(await Bun.file(project).exists()).toBe(false);
  });

  test("invalid names, conflicting sources and bad syntax fail without touching saved files", async () => {
    const root = await folder();
    const saved = new SavedWorkflows(root, join(root, "global"), join(root, "builtin"));
    await expect(saved.save("../outside", "return 1")).rejects.toMatchObject({ name: "WorkflowNameError" });
    await expect(saved.save("bad", "await (")).rejects.toMatchObject({ name: "ScriptSyntaxError" });
    await expect(saved.load({ name: "unknown" })).rejects.toMatchObject({ name: "WorkflowNotFoundError" });
    await expect(saved.load({ script: "return 1", name: "x" })).rejects.toMatchObject({ name: "WorkflowInputError" });
    expect(await readdir(root)).toEqual([]);
  });

  test("shipped workflows resolve from source without installation", async () => {
    const saved = new SavedWorkflows(await folder());
    expect((await saved.list()).map((entry) => entry.name)).toEqual(["audit", "implement-plan", "research", "review-changes"]);
    expect(await saved.load({ name: "review-changes" })).toContain("pipeline");
  });
});

test("semaphore preserves its slot when a queued waiter is cancelled", async () => {
  const semaphore = new Semaphore(1);
  const controller = new AbortController();
  const release = await semaphore.acquire(controller.signal);
  const skipped = new AbortController();
  const second = semaphore.acquire(skipped.signal);
  skipped.abort(new Error("skip"));
  await expect(second).rejects.toThrow("skip");
  let admitted = false;
  const third = semaphore.acquire(controller.signal).then((release) => { admitted = true; release(); });
  await Promise.resolve(); expect(admitted).toBe(false);
  release(); await third;
  expect(admitted).toBe(true);
  const final = await semaphore.acquire(controller.signal); final();
});
