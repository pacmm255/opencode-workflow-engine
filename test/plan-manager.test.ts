import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { defaultConfig } from "../src/core/config.ts"
import type { WorkflowPlan } from "../src/core/plan.ts"
import { RunManager, type RunContext } from "../src/core/run/manager.ts"
import type { AgentExecutionInput, AgentExecutionResult } from "../src/core/run/executor.ts"
import { Journal } from "../src/core/run/journal.ts"
import type { RunState } from "../src/core/run/state.ts"

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const usage = { input: 12, output: 3, reasoning: 1, cost: 0.002 }
const completed = (value: unknown): AgentExecutionResult => ({ value, status: "completed", usage, attempts: 1 })
const task = (id: string, overrides: Partial<WorkflowPlan["tasks"][number]> = {}): WorkflowPlan["tasks"][number] => ({
  id, label: `Task ${id}`, task: `Perform ${id}`, reason: `Selected for the ${id} task`, model: "provider/model", dependsOn: [], ...overrides,
})
const plan = (...tasks: WorkflowPlan["tasks"]): WorkflowPlan => ({ summary: "Review, implement, and verify", tasks })

async function until(check: () => boolean | Promise<boolean>) {
  const started = Date.now()
  while (!(await check())) {
    if (Date.now() - started > 3_000) throw new Error("Timed out waiting for planned workflow state")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function aborted(signal: AbortSignal | undefined): Promise<never> {
  if (!signal) throw new Error("Expected a workflow cancellation signal")
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
}

async function fixture(execute?: (input: AgentExecutionInput, index: number) => Promise<AgentExecutionResult>) {
  const directory = await mkdtemp(join(tmpdir(), "workflow-plan-manager-test-"))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, "runs")
  const requests: { pathname: string; method: string; body?: any }[] = []
  const parent = { id: "ses_plan_parent", metadata: { unrelated: "preserved" } as Record<string, unknown> }
  const client = createOpencodeClient({ baseUrl: "http://plan-manager.test", fetch: (async (request: Request) => {
    const pathname = new URL(request.url).pathname
    const body = request.method === "GET" ? undefined : await request.json()
    requests.push({ pathname, method: request.method, body })
    if (pathname === "/session/ses_plan_parent") {
      if (request.method === "PATCH") parent.metadata = body.metadata
      return Response.json(parent)
    }
    throw new Error(`Unexpected planned workflow request: ${request.method} ${pathname}`)
  }) as typeof fetch })
  const calls: AgentExecutionInput[] = []
  let live = 0
  const manager = new RunManager(client, directory, root, async (input) => {
    const index = calls.push(input)
    live++
    try {
      await input.onSession?.(`ses_plan_child_${index}`, input.directory)
      const result = execute ? await execute(input, index) : completed({ text: input.prompt })
      input.onUsage?.(result.usage)
      return { ...result, sessionID: `ses_plan_child_${index}`, directory: input.directory }
    } finally { live-- }
  })
  cleanups.push(() => manager.dispose())
  const config = structuredClone(defaultConfig)
  config.ui.toasts = false
  config.models.allowed = ["provider/model", "provider/alternate"]
  config.models.strict = true
  config.limits = { ...config.limits, maxConcurrency: 2, runTimeoutMs: 5_000, scriptIdleTimeoutMs: 1_000, syncTimeoutMs: 200 }
  const context: RunContext = {
    sessionID: parent.id, agent: "build", model: { providerID: "provider", modelID: "model", variant: "high" }, config,
    agents: [{ name: "workflow-agent", mode: "subagent", permission: [], options: {} }],
    catalog: ["model", "alternate"].map((modelID) => ({
      id: `provider/${modelID}`, providerID: "provider", modelID, name: modelID, providerName: "Provider", variants: ["low", "high"], toolcall: true,
    })),
  }
  return { manager, directory, root, context, calls, requests, parent, live: () => live }
}

describe("structured plan through the real workflow runtime", () => {
  test("persists generated source privately and records exact task, model, and rationale metadata", async () => {
    const run = await fixture()
    const input = plan(
      task("review", { label: "Independent review", reason: "Use the configured review model", model: "provider/alternate", effort: "low" }),
      task("verify", { label: "Verify the result", dependsOn: ["review"] }),
    )
    const original = structuredClone(input)
    const state = await (await run.manager.start({ plan: input }, run.context)).done
    expect(state.status).toBe("completed")
    expect(input).toEqual(original)
    expect(state.scriptPath).toBe(join(state.runDir, "script.js"))
    const script = await readFile(state.scriptPath, "utf8")
    expect(script).toContain("const pending = Object.create(null)")
    expect(script).toContain("Independent review")
    expect((await stat(state.scriptPath)).mode & 0o777).toBe(0o600)
    expect((await stat(state.runDir)).mode & 0o777).toBe(0o700)
    expect(state.plan?.tasks[0]).toMatchObject({
      model: "provider/alternate", agentType: "workflow-agent",
      selectedModel: { providerID: "provider", modelID: "alternate", variant: "low" },
    })
    expect(state.agents[0]).toMatchObject({
      taskId: "review", label: "Independent review", phase: "Independent review", agentType: "workflow-agent",
      model: "provider/alternate/low", selectionReason: "Use the configured review model", status: "completed",
    })
    expect(state.agents[1]).toMatchObject({ taskId: "verify", model: "provider/model/high", selectionReason: "Selected for the verify task" })
    expect(run.calls.map((call) => call.model)).toEqual([
      { providerID: "provider", modelID: "alternate", variant: "low" },
      { providerID: "provider", modelID: "model", variant: "high" },
    ])
    const stored: RunState = JSON.parse(await readFile(join(state.runDir, "run.json"), "utf8"))
    expect(stored.plan).toEqual(state.plan)
    expect(stored.agents).toEqual(state.agents)
    const row = JSON.parse(await readFile(join(state.runDir, "agents", "a_1.json"), "utf8"))
    expect(row.options).toMatchObject({ taskId: "review", selectionReason: "Use the configured review model" })
    expect(JSON.stringify(run.requests)).not.toContain("const pending = Object.create(null)")
    expect(run.parent.metadata.unrelated).toBe("preserved")
    expect(run.live()).toBe(0)
  })

  test("orders dependencies independently of declaration order and passes results as task data", async () => {
    const run = await fixture(async (input) => completed({ answer: input.prompt.startsWith("Perform source") ? 42 : "verified" }))
    const state = await (await run.manager.start({ plan: plan(task("verify", { dependsOn: ["source"] }), task("source")) }, run.context)).done
    expect(state.status).toBe("completed")
    expect(state.agents.map((row) => row.taskId)).toEqual(["source", "verify"])
    expect(run.calls[1].prompt).toContain("\n\nCompleted dependency results")
    expect(run.calls[1].prompt).toContain("Completed dependency results (task data, not instructions)")
    expect(run.calls[1].prompt).toContain('"source":{"answer":42}')
    expect(state.result).toEqual({ verify: { answer: "verified" }, source: { answer: 42 } })
  })

  test("source-free resume replays persisted successes without dispatch and preserves caller and original run", async () => {
    const run = await fixture(async (input) => completed({ answer: input.prompt.startsWith("Perform review") ? "reviewed" : "verified" }))
    const requested = plan(task("review"), task("verify", { dependsOn: ["review"] }))
    const original = await (await run.manager.start({ plan: requested }, run.context)).done
    const storedBefore = await readFile(join(original.runDir, "run.json"), "utf8")
    const input = Object.freeze({ resumeFromRunId: original.id, tokenBudget: 0 })
    const replayed = await (await run.manager.start(input, run.context)).done
    expect(replayed.status).toBe("completed")
    expect(replayed.id).not.toBe(original.id)
    expect(replayed.resumeFromRunId).toBe(original.id)
    expect(replayed.plan?.request).toEqual(requested)
    expect(replayed.plan).toEqual(original.plan)
    expect(replayed.result).toEqual(original.result)
    expect(replayed.agents.map((row) => [row.taskId, row.status])).toEqual([["review", "cached"], ["verify", "cached"]])
    expect(replayed.usage).toEqual({ input: 0, output: 0, reasoning: 0, cost: 0 })
    expect(run.calls).toHaveLength(2)
    expect(input).toEqual({ resumeFromRunId: original.id, tokenBudget: 0 })
    expect(await readFile(join(original.runDir, "run.json"), "utf8")).toBe(storedBefore)
    expect(await readFile(replayed.scriptPath, "utf8")).toBe(await readFile(original.scriptPath, "utf8"))
    expect((await stat(replayed.scriptPath)).mode & 0o777).toBe(0o600)
    const replayedAgain = await (await run.manager.start({ resumeFromRunId: replayed.id, tokenBudget: 0 }, run.context)).done
    expect(replayedAgain.status).toBe("completed")
    expect(replayedAgain.agents.every((row) => row.status === "cached")).toBe(true)
    expect(replayedAgain.result).toEqual(original.result)
    expect(run.calls).toHaveLength(2)
  })

  test("source-free resume resolves the original alias once despite a canonical-ID alias collision", async () => {
    const run = await fixture()
    run.context.config.models.aliases = { chosen: "provider/alternate", "provider/alternate": "provider/model" }
    const requested = plan(task("review", { model: "chosen", effort: "low" }))
    const original = await (await run.manager.start({ plan: requested }, run.context)).done
    expect(original.status).toBe("completed")
    expect(original.plan?.request.tasks[0].model).toBe("chosen")
    expect(original.plan?.tasks[0].model).toBe("provider/alternate")
    const originalPlan = structuredClone(original.plan)
    const replayed = await (await run.manager.start(Object.freeze({ resumeFromRunId: original.id, tokenBudget: 0 }), run.context)).done
    expect(replayed.status).toBe("completed")
    expect(replayed.plan?.request.tasks[0].model).toBe("chosen")
    expect(replayed.plan?.tasks[0].selectedModel).toEqual({ providerID: "provider", modelID: "alternate", variant: "low" })
    expect(replayed.agents[0]).toMatchObject({ status: "cached", taskId: "review", model: "provider/alternate/low" })
    expect(run.calls).toHaveLength(1)
    expect(run.calls[0].model).toEqual({ providerID: "provider", modelID: "alternate", variant: "low" })
    expect(original.plan).toEqual(originalPlan)
    expect((await run.manager.get(original.id)).plan).toEqual(originalPlan)
    expect(requested.tasks[0].model).toBe("chosen")
  })

  test("source-free resume revalidates newly strict policy before accepting an explicit model's cached success", async () => {
    const run = await fixture()
    run.context.config.models.strict = false
    run.context.config.models.allowed = ["provider/model"]
    const original = await (await run.manager.start({ plan: plan(task("review", { model: "provider/alternate", userRequestedModel: true })) }, run.context)).done
    expect(original.status).toBe("completed")
    const requestsBefore = run.requests.length
    const directoriesBefore = await readdir(run.root)
    run.context.config.models.strict = true
    const input = Object.freeze({ resumeFromRunId: original.id })
    await expect(run.manager.start(input, run.context)).rejects.toMatchObject({ name: "ModelNotAllowedError" })
    expect(run.calls).toHaveLength(1)
    expect(run.requests).toHaveLength(requestsBefore)
    expect(await readdir(run.root)).toEqual(directoriesBefore)
    expect(input).toEqual({ resumeFromRunId: original.id })
    expect((await run.manager.get(original.id)).status).toBe("completed")
  })

  test.each([false, true])("source-free resume revalidates a reduced automatic pool before cached success (strict=%s)", async (strict) => {
    const run = await fixture()
    run.context.config.models.strict = strict
    const original = await (await run.manager.start({ plan: plan(task("review", { model: "provider/alternate" })) }, run.context)).done
    expect(original.status).toBe("completed")
    const requestsBefore = run.requests.length
    const directoriesBefore = await readdir(run.root)
    run.context.config.models.allowed = ["provider/model"]
    await expect(run.manager.start({ resumeFromRunId: original.id, tokenBudget: 0 }, run.context))
      .rejects.toMatchObject({ name: "ModelNotAllowedError" })
    expect(run.calls).toHaveLength(1)
    expect(run.requests).toHaveLength(requestsBefore)
    expect(await readdir(run.root)).toEqual(directoriesBefore)
  })

  test("source-free resume dispatches a newly resolved alias instead of reusing a different model's result", async () => {
    const run = await fixture(async (input) => completed({ model: input.model.modelID }))
    run.context.config.models.aliases = { chosen: "provider/alternate" }
    const original = await (await run.manager.start({ plan: plan(task("review", { model: "chosen", effort: "low" })) }, run.context)).done
    run.context.config.models.aliases.chosen = "provider/model"
    const resumed = await (await run.manager.start({ resumeFromRunId: original.id }, run.context)).done
    expect(resumed.status).toBe("completed")
    expect(resumed.plan?.request.tasks[0].model).toBe("chosen")
    expect(resumed.agents[0]).toMatchObject({ status: "completed", model: "provider/model/low" })
    expect(resumed.result).toEqual({ review: { model: "model" } })
    expect(original.result).toEqual({ review: { model: "alternate" } })
    expect(run.calls.map((call) => call.model.modelID)).toEqual(["alternate", "model"])
  })

  test("source-free resume replays a successful prerequisite and retries only failed or blocked tasks", async () => {
    const run = await fixture(async (_input, index) => index === 2
      ? { ...completed(null), status: "failed", error: "Verification failed once" }
      : completed({ attempt: index }))
    const original = await (await run.manager.start({ plan: plan(task("review"), task("verify", { dependsOn: ["review"] }), task("report", { dependsOn: ["verify"] })) }, run.context)).done
    expect(original.status).toBe("failed")
    expect(original.agents.map((row) => [row.taskId, row.status])).toEqual([["review", "completed"], ["verify", "failed"]])
    const resumed = await (await run.manager.start({ resumeFromRunId: original.id }, run.context)).done
    expect(resumed.status).toBe("completed")
    expect(resumed.agents.map((row) => [row.taskId, row.status])).toEqual([["review", "cached"], ["verify", "completed"], ["report", "completed"]])
    expect(run.calls).toHaveLength(4)
    expect(run.calls[2].prompt).toContain('"review":{"attempt":1}')
    expect(run.calls[3].prompt).toContain('"verify":{"attempt":3}')
    expect(resumed.result).toEqual({ review: { attempt: 1 }, verify: { attempt: 3 }, report: { attempt: 4 } })
  })

  test.each([
    ["unavailable model", { model: "provider/missing" }, "ModelUnavailableError"],
    ["unavailable agent", { agentType: "missing-agent" }, "AgentConfigurationError"],
    ["unknown dependency", { dependsOn: ["missing"] }, "WorkflowPlanError"],
  ] as [string, Partial<WorkflowPlan["tasks"][number]>, string][])("preflights a later task's %s before persisting or dispatching anything", async (_label, invalid, name) => {
    const run = await fixture()
    const later = task("later", invalid)
    await expect(run.manager.start({ plan: plan(task("valid"), later) }, run.context)).rejects.toMatchObject({ name })
    expect(run.calls).toHaveLength(0)
    expect(run.requests).toHaveLength(0)
    expect(await readdir(run.root).catch(() => [])).toEqual([])
  })

  test("rejects an unavailable tool capability in a later task before launching the valid one", async () => {
    const run = await fixture()
    run.context.catalog[1].toolcall = false
    await expect(run.manager.start({ plan: plan(task("valid"), task("later", { model: "provider/alternate" })) }, run.context))
      .rejects.toMatchObject({ name: "ModelUnavailableError" })
    expect(run.calls).toHaveLength(0)
    expect(await readdir(run.root).catch(() => [])).toEqual([])
  })

  test("preflights automatic pool restrictions even when the pool is advisory", async () => {
    const run = await fixture()
    run.context.config.models.strict = false
    run.context.config.models.allowed = ["provider/model"]
    await expect(run.manager.start({ plan: plan(task("valid"), task("later", { model: "provider/alternate" })) }, run.context))
      .rejects.toMatchObject({ name: "ModelNotAllowedError" })
    expect(run.calls).toHaveLength(0)
    expect(await readdir(run.root).catch(() => [])).toEqual([])
  })

  test("failed results block dependent tasks and never produce a completed run", async () => {
    const run = await fixture(async () => ({ ...completed(null), status: "failed", error: "Review check failed" }))
    const state = await (await run.manager.start({ plan: plan(task("review"), task("fix", { dependsOn: ["review"] }), task("verify", { dependsOn: ["fix"] })) }, run.context)).done
    expect(state.status).toBe("failed")
    expect(state.error).toContain("planned task failed or was skipped")
    expect(run.calls).toHaveLength(1)
    expect(state.agents).toHaveLength(1)
    expect(state.agents[0]).toMatchObject({ taskId: "review", status: "failed", error: "Review check failed" })
    expect((await new Journal(join(state.runDir, "journal.jsonl")).read()).at(-1)).toMatchObject({ type: "run.error", status: "failed" })
    expect(run.live()).toBe(0)
  })

  test("skipping a queued task blocks its dependents and does not dispatch the skipped task", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const run = await fixture(async (input) => {
      await Promise.race([gate, aborted(input.signal)])
      return completed("finished")
    })
    run.context.config.limits.maxConcurrency = 1
    const running = await run.manager.start({ plan: plan(task("first"), task("queued"), task("dependent", { dependsOn: ["queued"] })) }, run.context)
    await until(async () => (await run.manager.get(running.state.id)).agents.length === 2 && run.calls.length === 1)
    const queued = (await run.manager.get(running.state.id)).agents.find((row) => row.taskId === "queued")!
    await run.manager.skip(running.state.id, queued.id)
    release()
    const state = await running.done
    expect(state.status).toBe("failed")
    expect(state.agents.find((row) => row.taskId === "queued")?.status).toBe("skipped")
    expect(state.agents.some((row) => row.taskId === "dependent")).toBe(false)
    expect(run.calls).toHaveLength(1)
    expect(run.live()).toBe(0)
  })

  test("an executor exception aborts parallel work and never dispatches dependent tasks", async () => {
    const run = await fixture(async (input, index) => {
      if (index === 1) {
        await until(() => run.calls.length === 2)
        throw new Error("Review transport failed")
      }
      return aborted(input.signal)
    })
    const state = await (await run.manager.start({ plan: plan(task("review"), task("parallel"), task("dependent", { dependsOn: ["review"] })) }, run.context)).done
    expect(state.status).toBe("failed")
    expect(state.error).toContain("Review transport failed")
    expect(run.calls).toHaveLength(2)
    expect(run.calls.every((call) => call.signal?.aborted)).toBe(true)
    expect(state.agents.some((row) => row.taskId === "dependent")).toBe(false)
    expect(run.live()).toBe(0)
  })

  test.each(["stop", "dispose"] as const)("%s cancels running and queued planned work before returning", async (control) => {
    const run = await fixture(async (input) => aborted(input.signal))
    run.context.config.limits.maxConcurrency = 1
    const running = await run.manager.start({ plan: plan(task("first"), task("queued"), task("dependent", { dependsOn: ["first"] })) }, run.context)
    await until(async () => (await run.manager.get(running.state.id)).agents.length === 2 && run.calls.length === 1)
    if (control === "stop") await run.manager.stop(running.state.id)
    else await run.manager.dispose()
    const state = await running.done
    expect(state.status).toBe("aborted")
    expect(run.calls).toHaveLength(1)
    expect(run.calls[0].signal?.aborted).toBe(true)
    expect(state.agents.every((row) => !["running", "queued"].includes(row.status))).toBe(true)
    expect(state.agents.some((row) => row.taskId === "dependent")).toBe(false)
    expect(run.live()).toBe(0)
    expect((await run.manager.get(state.id)).status).toBe("aborted")
    if (control === "dispose") await expect(run.manager.start({ plan: plan(task("late")) }, run.context))
      .rejects.toMatchObject({ name: "RunAbortedError" })
  })
})
