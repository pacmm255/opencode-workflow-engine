import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { defaultConfig } from "../src/core/config.ts"
import { RunManager, type RunContext } from "../src/core/run/manager.ts"
import type { AgentExecutionInput, AgentExecutionResult } from "../src/core/run/executor.ts"
import type { RunState } from "../src/core/run/state.ts"
import { Journal } from "../src/core/run/journal.ts"

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const usage = (output = 0, reasoning = 0) => ({ input: 10, output, reasoning, cost: 0.01 })
const success = (value: unknown, overrides: Partial<AgentExecutionResult> = {}): AgentExecutionResult => ({ value, status: "completed", usage: usage(), attempts: 1, ...overrides })
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
async function until(check: () => boolean | Promise<boolean>) {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > 3_000) throw new Error("Timed out waiting for manager state")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
async function waitForAbort(signal: AbortSignal | undefined): Promise<never> {
  if (!signal) throw new Error("Expected executor cancellation signal")
  if (signal.aborted) throw signal.reason
  return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
}
async function fixture(execute?: (input: AgentExecutionInput, index: number) => Promise<AgentExecutionResult>) {
  const directory = await mkdtemp(join(tmpdir(), "workflow-manager-test-"))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, "runs")
  const requests: { pathname: string; method: string; body?: any }[] = []
  let parentBusy = false
  const parent = { id: "ses_parent", agent: "parent-agent", model: { providerID: "provider", id: "model", variant: "high" }, metadata: { unrelated: "keep" } }
  const client = createOpencodeClient({ baseUrl: "http://manager.test", fetch: (async (request: Request) => {
    const pathname = new URL(request.url).pathname
    const body = request.method === "GET" ? undefined : await request.json().catch(() => ({}))
    requests.push({ pathname, method: request.method, body })
    if (pathname === "/session/status") return Response.json(parentBusy ? { ses_parent: { type: "busy" } } : {})
    if (pathname === "/session/ses_parent/prompt_async") return new Response(null, { status: 204 })
    if (pathname === "/session/ses_parent") {
      if (request.method === "PATCH") parent.metadata = body.metadata
      return Response.json(parent)
    }
    throw new Error(`Unexpected manager request: ${request.method} ${pathname}`)
  }) as typeof fetch })
  const calls: AgentExecutionInput[] = []
  const manager = new RunManager(client, directory, root, async (input) => {
    calls.push(input)
    const index = calls.length
    await input.onSession?.(`ses_child_${index}`, input.directory)
    return execute ? execute(input, index) : success(input.prompt, { sessionID: `ses_child_${index}`, directory: input.directory })
  })
  cleanups.push(() => manager.dispose())
  const config = structuredClone(defaultConfig)
  config.limits = { ...config.limits, maxConcurrency: 2, runTimeoutMs: 5_000, scriptIdleTimeoutMs: 1_000, syncTimeoutMs: 200 }
  const context: RunContext = {
    sessionID: "ses_parent", agent: "parent-agent", model: { providerID: "provider", modelID: "model", variant: "high" }, config,
    agents: [{ name: "workflow-agent", mode: "subagent", permission: [], options: {} }],
    catalog: ["model", "alternate"].map((modelID) => ({ id: `provider/${modelID}`, providerID: "provider", modelID, name: modelID, providerName: "Provider", variants: ["low", "high"], toolcall: true })),
  }
  return { manager, client, context, directory, root, requests, calls, parent, setBusy(value: boolean) { parentBusy = value } }
}

describe("durable workflow run manager", () => {
  test("run discovery limits simultaneous disk reads and still returns all matching runs", async () => {
    const f = await fixture();
    for (let index = 0; index < 24; index++) {
      const id = `wf_${randomUUID()}`;
      const runDir = join(f.root, id);
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "run.json"), JSON.stringify({ id, runDir, directory: f.directory, sessionID: index % 2 ? "other" : "ses_parent", startedAt: index, status: "completed" }));
    }
    let concurrent = 0; let peak = 0;
    const get = f.manager.get.bind(f.manager);
    f.manager.get = async id => {
      peak = Math.max(peak, ++concurrent);
      try { await Bun.sleep(2); return await get(id); } finally { concurrent--; }
    };
    const rows = await f.manager.list("ses_parent");
    expect(rows).toHaveLength(12); expect(rows[0]?.startedAt).toBe(22); expect(peak).toBeLessThanOrEqual(4);
  });

  test("quiet runs publish only changes while usage and completion still reach the parent", async () => {
    const gate = deferred();
    let current: AgentExecutionInput | undefined;
    const f = await fixture(async input => { current = input; await gate.promise; return success("done"); });
    f.context.config.limits.runTimeoutMs = 10_000;
    // The artificial wall-clock jump must not trip the independent worker liveness guard.
    f.context.config.limits.scriptIdleTimeoutMs = 120_000;
    const run = await f.manager.start({ script: "return await agent('work')" }, f.context);
    const updates = () => f.requests.filter(request => request.method === "PATCH");
    try {
      await until(() => !!current && updates().length === 1);
      await Bun.sleep(1250);
      expect(updates()).toHaveLength(1);
      delete (f.parent.metadata as Record<string, unknown>).workflow;
      const now = Date.now;
      const clock = spyOn(Date, "now").mockImplementation(() => now() + 61_000);
      try { await until(() => updates().length === 2); }
      finally { clock.mockRestore(); }
      expect(f.parent.metadata).toHaveProperty("workflow.status", "running");
      current!.onUsage?.(usage(5, 2));
      await until(() => updates().length === 3);
      gate.resolve(); const done = await run.done;
      expect(done.status).toBe("completed"); expect(updates()).toHaveLength(4);
      expect(updates().at(-1)?.body.metadata.workflow).toMatchObject({ status: "completed", usage: { output: 5, reasoning: 2 } });
    } finally { gate.resolve(); await run.done; }
  }, 10_000);

  test("coalesced run snapshots preserve every queued child and its durable session before execution", async () => {
    const f = await fixture(async input => {
      const saved = JSON.parse(await readFile(join(f.root, input.workflow!.runId, "run.json"), "utf8"));
      expect(saved.agents.find((row: { id: string }) => row.id === input.workflow!.agentId)?.sessionID).toBeTruthy();
      return success(input.prompt);
    });
    const done = await (await f.manager.start({ script: "return await parallel(Array.from({length:24},(_,i)=>()=>agent('item '+i)))" }, f.context)).done;
    expect(done.status).toBe("completed"); expect(done.agents).toHaveLength(24);
    expect(done.agents.every(row => row.status === "completed")).toBe(true);
    expect(JSON.parse(await readFile(join(done.runDir, "run.json"), "utf8")).agents).toEqual(done.agents);
  });
  test("journals a child session before dispatch and preserves parent metadata", async () => {
    let observed: RunState | undefined
    const run = await fixture(async (input) => {
      observed = JSON.parse(await readFile(join(run.root, input.workflow!.runId, "run.json"), "utf8"))
      const events = await new Journal(join(run.root, input.workflow!.runId, "journal.jsonl")).read()
      expect(events.some((event) => event.type === "agent.session" && event.sessionID === "ses_child_1")).toBe(true)
      input.onUsage?.(usage(3, 4))
      return success({ answer: 42 }, { usage: usage(3, 4) })
    })
    const completed = await (await run.manager.start({ script: "return await agent('question', {label:'Answer', phase:'Review'});" }, run.context)).done
    expect(observed!.agents[0]).toMatchObject({ status: "running", sessionID: "ses_child_1", directory: run.directory })
    expect(completed).toMatchObject({ status: "completed", result: { answer: 42 }, usage: { output: 3, reasoning: 4 } })
    expect(completed.agents[0]).toMatchObject({ label: "Answer", phase: "Review", status: "completed", sessionID: "ses_child_1" })
    expect(run.parent.metadata.unrelated).toBe("keep")
    expect(JSON.parse(await readFile(join(completed.runDir, "result.json"), "utf8"))).toEqual({ answer: 42 })
    expect((await new Journal(join(completed.runDir, "journal.jsonl")).read()).at(-1)).toMatchObject({ type: "run.done", status: "completed" })
  })

  test("resume consumes successful duplicates in invocation order and excludes cached usage", async () => {
    const run = await fixture(async (input, index) => {
      if (index === 1) await new Promise((resolve) => setTimeout(resolve, 20))
      input.onUsage?.(usage(1))
      return success(index, { usage: usage(1) })
    })
    const first = await (await run.manager.start({ script: "return parallel([()=>agent('repeat',{label:'old first'}),()=>agent('repeat',{label:'old second'})]);" }, run.context)).done
    expect(first.result).toEqual([1, 2])
    const resumed = await (await run.manager.start({ resumeFromRunId: first.id, script: "phase('new phase'); return parallel([()=>agent('repeat',{label:'new first'}),()=>agent('repeat',{label:'new second'}),()=>agent('repeat',{label:'third'})]);" }, run.context)).done
    expect(resumed.result).toEqual([1, 2, 3])
    expect(resumed.agents.map((agent) => agent.status)).toEqual(["cached", "cached", "completed"])
    expect(resumed.usage.output).toBe(1)
    expect(run.calls).toHaveLength(3)
    const again = await (await run.manager.start({ resumeFromRunId: resumed.id, script: "return parallel([()=>agent('repeat'),()=>agent('repeat'),()=>agent('repeat')]);", tokenBudget: 0 }, run.context)).done
    expect(again.result).toEqual([1, 2, 3])
    expect(again.usage.output).toBe(0)
    expect(run.calls).toHaveLength(3)
  })

  test("strict model preflight runs before cache lookup", async () => {
    const run = await fixture()
    const script = "return agent('reusable', {model:'provider/alternate'});"
    const first = await (await run.manager.start({ script }, run.context)).done
    expect(first.status).toBe("completed")
    run.context.config.models.strict = true
    run.context.config.models.allowed = ["provider/model"]
    const second = await (await run.manager.start({ script, resumeFromRunId: first.id }, run.context)).done
    expect(second.status).toBe("failed")
    expect(second.error).toContain("ModelNotAllowedError")
    expect(second.agents).toHaveLength(0)
    expect(run.calls).toHaveLength(1)
  })

  test("budget.spent includes reasoning and later calls throw at the ceiling", async () => {
    const run = await fixture(async (input) => { input.onUsage?.(usage(3, 4)); return success("first", { usage: usage(3, 4) }) })
    const completed = await (await run.manager.start({ tokenBudget: 7, script: "await agent('first'); const spent=budget.spent(); try { await agent('second'); } catch (error) { return {spent,remaining:budget.remaining(),name:error.name}; }" }, run.context)).done
    expect(completed).toMatchObject({ status: "completed", result: { spent: 7, remaining: 0, name: "BudgetExceededError" } })
    expect(run.calls).toHaveLength(1)
  })

  test("queued work checks the updated token budget before consuming a slot", async () => {
    const run = await fixture(async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      input.onUsage?.(usage(3, 4))
      return success(input.prompt, { usage: usage(3, 4) })
    })
    run.context.config.limits.maxConcurrency = 1
    const completed = await (await run.manager.start({ tokenBudget: 7, script: "return parallel([()=>agent('first'),()=>agent('queued')]);" }, run.context)).done
    expect(completed.result).toEqual(["first", null])
    expect(completed.agents.map((agent) => agent.status)).toEqual(["completed", "failed"])
    expect(completed.agents[1].error).toContain("BudgetExceededError")
    expect(run.calls).toHaveLength(1)
  })

  test("background runs detach from the invoking abort and preserve notification model/agent", async () => {
    const run = await fixture()
    run.context.abort = AbortSignal.abort(new Error("The invoking tool returned"))
    const completed = await (await run.manager.start({ background: true, script: "return agent('background');" }, run.context)).done
    expect(completed.status).toBe("completed")
    expect(run.calls[0].signal!.aborted).toBe(true) // The run owns this signal and closes it after completion.
    await until(async () => (await run.manager.get(completed.id)).notification === "delivered")
    const notification = run.requests.find((request) => request.pathname.endsWith("/prompt_async"))!.body
    expect(notification).toMatchObject({ agent: "parent-agent", model: { providerID: "provider", modelID: "model" }, variant: "high" })
    expect(notification.parts[0]).toMatchObject({ type: "text", synthetic: true })
    expect(notification.parts[0].text).toContain(completed.id)
  })

  test("background completion waits to notify while the parent is busy", async () => {
    const run = await fixture()
    run.setBusy(true)
    await run.manager.recover()
    const completed = await (await run.manager.start({ background: true, script: "return agent('background');" }, run.context)).done
    expect(completed.status).toBe("completed")
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(run.requests.filter((request) => request.pathname.endsWith("/prompt_async"))).toHaveLength(0)
    run.setBusy(false)
    await until(async () => (await run.manager.get(completed.id)).notification === "delivered")
    expect((await run.manager.get(completed.id)).notification).toBe("delivered")
  })

  test("foreground abort reaches running agents and produces an aborted run", async () => {
    const started = deferred()
    const run = await fixture(async (input) => { started.resolve(); return waitForAbort(input.signal) })
    const controller = new AbortController()
    run.context.abort = controller.signal
    const running = await run.manager.start({ script: "return agent('blocked');" }, run.context)
    await started.promise
    controller.abort(new Error("User cancelled parent"))
    const completed = await running.done
    expect(completed.status).toBe("aborted")
    expect(run.calls[0].signal!.aborted).toBe(true)
    expect(completed.agents[0].status).toBe("failed")
  })

  test("skipping a queued agent never dispatches it", async () => {
    const gate = deferred()
    const run = await fixture(async (input) => { await Promise.race([gate.promise, waitForAbort(input.signal)]); return success(input.prompt) })
    run.context.config.limits.maxConcurrency = 1
    const running = await run.manager.start({ script: "return parallel([()=>agent('first'),()=>agent('queued')]);" }, run.context)
    await until(async () => (await run.manager.get(running.state.id)).agents.length === 2 && run.calls.length === 1)
    await run.manager.skip(running.state.id, "a_2")
    gate.resolve()
    const completed = await running.done
    expect(completed).toMatchObject({ status: "completed", result: ["first", null] })
    expect(completed.agents[1].status).toBe("skipped")
    expect(run.calls).toHaveLength(1)
  })

  test("explicit stop aborts children and leaves a recoverable journal", async () => {
    const started = deferred()
    const run = await fixture(async (input) => { started.resolve(); return waitForAbort(input.signal) })
    const running = await run.manager.start({ script: "return agent('blocked');" }, run.context)
    await started.promise
    await run.manager.stop(running.state.id)
    const completed = await running.done
    expect(completed.status).toBe("aborted")
    expect((await readFile(join(completed.runDir, "STOP"), "utf8")).trim().length).toBeGreaterThan(0)
    expect((await new Journal(join(completed.runDir, "journal.jsonl")).read()).at(-1)?.type).toBe("run.error")
    await expect(run.manager.stop(completed.id)).resolves.toBeUndefined()
  })

  test("recovery marks dead owners interrupted and never rewrites another project's runs", async () => {
    const run = await fixture()
    const local = await (await run.manager.start({ script: "return 1;" }, run.context)).done
    const foreignManager = new RunManager(run.client, join(run.directory, "other-project"), run.root)
    cleanups.push(() => foreignManager.dispose())
    const foreign = await (await foreignManager.start({ script: "return 2;" }, run.context)).done
    for (const state of [local, foreign]) {
      state.status = "running"
      state.ownerPID = 2_147_483_647
      await writeFile(join(state.runDir, "run.json"), JSON.stringify(state))
    }
    await run.manager.recover()
    expect((await run.manager.get(local.id)).status).toBe("interrupted")
    expect(JSON.parse(await readFile(join(foreign.runDir, "run.json"), "utf8")).status).toBe("running")
    await expect(run.manager.get(foreign.id)).rejects.toMatchObject({ name: "RunNotFoundError" })
    expect((await run.manager.list()).map((state) => state.id)).toEqual([local.id])
  })

  test("default agents inherit session model while an explicit agent selects its configured model", async () => {
    const run = await fixture()
    run.context.agents[0].model = { providerID: "provider", modelID: "alternate" }
    run.context.agents[0].variant = "low"
    const completed = await (await run.manager.start({ script: "await agent('implicit'); return agent('explicit',{agentType:'workflow-agent'});" }, run.context)).done
    expect(completed.status).toBe("completed")
    expect(run.calls[0].model).toEqual({ providerID: "provider", modelID: "model", variant: "high" })
    expect(run.calls[1].model).toEqual({ providerID: "provider", modelID: "alternate", variant: "low" })
  })
})
