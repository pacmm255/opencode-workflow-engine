import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Agent, OpencodeClient } from "@opencode-ai/sdk/v2";
import { defaultConfig } from "../src/core/config.ts";
import { RunManager, type RunContext } from "../src/core/run/manager.ts";
import type { AgentExecutionInput, AgentExecutionResult } from "../src/core/run/executor.ts";

const cleanup: Array<{ root: string; manager: RunManager }> = [];
afterEach(async () => {
  for (const { root, manager } of cleanup.splice(0)) {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function bounded<T>(operation: Promise<T>, ms = 1500): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Operation did not settle within the test deadline")), ms); })]); }
  finally { clearTimeout(timer!); }
}
const never = () => new Promise<never>(() => {});
const successful: AgentExecutionResult = { value: "finished", status: "completed", usage: { input: 0, output: 0, reasoning: 0, cost: 0 }, attempts: 1 };

async function fixture(
  session: Record<string, unknown> = {},
  execute: (input: AgentExecutionInput) => Promise<AgentExecutionResult> = async () => successful,
  requestTimeoutMs = 25,
) {
  const root = await mkdtemp(join(tmpdir(), "workflow-manager-lifecycle-"));
  const client = { session: {
    get: async () => ({ data: { metadata: {}, agent: "build", model: { providerID: "test", id: "model" } } }),
    update: async () => ({ data: {} }), status: async () => ({ data: {} }), promptAsync: async () => ({ data: undefined }),
    ...session,
  } } as unknown as OpencodeClient;
  const manager = new RunManager(client, root, join(root, "runs"), execute, { requestTimeoutMs });
  cleanup.push({ root, manager });
  const context: RunContext = {
    sessionID: "ses_parent", agent: "build", model: { providerID: "test", modelID: "model" },
    config: structuredClone(defaultConfig),
    catalog: [{ id: "test/model", providerID: "test", modelID: "model", name: "Model", providerName: "Test", variants: [], toolcall: true }],
    agents: [{ name: "workflow-agent", mode: "subagent" }] as Agent[],
  };
  return { root, manager, context };
}

test.each(["get", "update"])("finalization settles when progress %s ignores its abort signal", async (method) => {
  const f = await fixture({ [method]: never });
  const run = await f.manager.start({ script: "return 42" }, f.context);
  const result = await bounded(run.done);
  expect(result.status).toBe("completed");
  expect(result.result).toBe(42);
  expect(JSON.parse(await readFile(join(result.runDir, "run.json"), "utf8")).status).toBe("completed");
});

test("dispose cancels pending final progress immediately even when transport ignores cancellation", async () => {
  const started = deferred<AbortSignal>();
  const f = await fixture({ get: (_input: unknown, options: { signal: AbortSignal }) => { started.resolve(options.signal); return never(); } }, undefined, 5000);
  const run = await f.manager.start({ script: "return 42" }, f.context);
  const signal = await bounded(started.promise);
  await bounded(f.manager.dispose(), 300);
  expect(signal.aborted).toBe(true);
  expect((await run.done).status).toBe("completed");
});

test("timed out background notifications fail visibly instead of blocking the notification loop", async () => {
  const called = deferred<void>();
  const f = await fixture({ status: () => { called.resolve(); return never(); } });
  const run = await f.manager.start({ script: "return 42", background: true }, f.context);
  const done = await bounded(run.done);
  await bounded(called.promise);
  await bounded((async () => {
    while (true) {
      const record = JSON.parse(await readFile(join(done.runDir, "run.json"), "utf8"));
      if (record.notification === "failed") {
        expect(record.warnings.join(" ")).toContain("notification failed");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  })());
});

test("disposing a pending notification preserves it for recovery", async () => {
  const started = deferred<AbortSignal>();
  const f = await fixture({ status: (_input: unknown, options: { signal: AbortSignal }) => { started.resolve(options.signal); return never(); } }, undefined, 5000);
  const run = await f.manager.start({ script: "return 42", background: true }, f.context);
  const done = await bounded(run.done);
  const signal = await bounded(started.promise);
  await bounded(f.manager.dispose(), 300);
  expect(signal.aborted).toBe(true);
  expect(JSON.parse(await readFile(join(done.runDir, "run.json"), "utf8")).notification).toBe("pending");
});

test("late successful execution after skip resolves null and never enters the success cache", async () => {
  const started = deferred<void>();
  const response = deferred<AgentExecutionResult>();
  const f = await fixture({}, async () => { started.resolve(); return response.promise; });
  const run = await f.manager.start({ script: 'return await agent("work")' }, f.context);
  await bounded(started.promise);
  await f.manager.skip(run.state.id, "a_1");
  response.resolve(successful);
  const done = await bounded(run.done);
  expect(done.result).toBeNull();
  expect(done.agents[0]?.status).toBe("skipped");
  const journal = await readFile(join(done.runDir, "journal.jsonl"), "utf8");
  expect(journal).toContain("agent.skipped");
  expect(journal).not.toContain("agent.result");
});

test("terminal agents cannot receive a new skip control", async () => {
  const f = await fixture();
  const run = await f.manager.start({ script: 'return await agent("work")' }, f.context);
  const done = await bounded(run.done);
  await expect(f.manager.skip(done.id, "a_1")).rejects.toThrow("no longer running");
  await expect(readFile(join(done.runDir, "SKIP_a_1"))).rejects.toThrow();
});

test.each(["STOP", "SKIP_a_1"])("control %s cannot follow a symlink and overwrite a file", async (control) => {
  const started = deferred<void>();
  const response = deferred<AgentExecutionResult>();
  const f = await fixture({}, async () => { started.resolve(); return response.promise; });
  const run = await f.manager.start({ script: 'return await agent("work")' }, f.context);
  await bounded(started.promise);
  const target = join(f.root, "untouched.txt");
  await writeFile(target, "keep");
  await symlink(target, join(run.state.runDir, control));
  try {
    await expect(control === "STOP" ? f.manager.stop(run.state.id) : f.manager.skip(run.state.id, "a_1")).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("keep");
  } finally { response.resolve(successful); }
  await bounded(run.done);
});
