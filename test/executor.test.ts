import { describe, expect, test } from "bun:test"
import { createOpencodeClient, type AssistantMessage, type SessionMessagesResponse2 } from "@opencode-ai/sdk/v2"
import { executeAgent, AgentConfigurationError, type AgentExecutionInput } from "../src/core/run/executor.ts"
import { validateSchema, UnsatisfiableSchemaError } from "../src/core/run/schema.ts"

type Child = { id: string; prompts: { messageID: string; parts: { text: string }[] }[]; polls: number; attempt: number }
type Snapshot = { status?: "idle" | "busy" | "retry"; messages?: SessionMessagesResponse2 }
function assistant(child: Child, overrides: Partial<AssistantMessage> = {}, text = "done"): SessionMessagesResponse2[number] {
  const parentID = child.prompts.at(-1)!.messageID
  const info: AssistantMessage = {
    id: `${parentID}a`, parentID, sessionID: child.id, role: "assistant", time: { created: 2, completed: 3 },
    agent: "workflow-agent", mode: "subagent", modelID: "model", providerID: "provider", path: { cwd: "/project", root: "/project" },
    cost: 0.01, tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 0, write: 0 } }, finish: "stop", ...overrides,
  }
  return { info, parts: [{ id: `${info.id}p`, sessionID: child.id, messageID: info.id, type: "text", text }] }
}
function user(child: Child): SessionMessagesResponse2[number] {
  return { info: { id: child.prompts.at(-1)!.messageID, sessionID: child.id, role: "user", time: { created: 1 }, agent: "workflow-agent", model: { providerID: "provider", modelID: "model" } }, parts: [] }
}
function fake(snapshot: (child: Child) => Snapshot = (child) => ({ messages: [user(child), assistant(child)] }), behavior: { abortFails?: boolean; hangStatus?: boolean; createDelayMs?: number; worktreeFails?: boolean; formatEncodingBug?: boolean | string; parentPermission?: unknown[] } = {}) {
  const calls: { method: string; pathname: string; directory: string | null; body: any; limit: string | null }[] = []
  const children: Child[] = []
  let aborted = 0
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined
  let readyBeforeCreateReturns = false
  const emit = (event: unknown) => stream!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`))
  const client = createOpencodeClient({ baseUrl: "http://executor.test", fetch: (async (request: Request) => {
    const url = new URL(request.url)
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : undefined
    calls.push({ method: request.method, pathname: url.pathname, directory: url.searchParams.get("directory"), body, limit: url.searchParams.get("limit") })
    if (url.pathname === "/session/ses_parent") return Response.json({ id: "ses_parent", agent: "build", permission: behavior.parentPermission ?? [] })
    if (url.pathname === "/global/event") {
      const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; emit({ payload: { type: "server.connected", properties: {} } }) }, cancel() { stream = undefined } })
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    }
    if (url.pathname === "/experimental/worktree") {
      if (!stream) throw new Error("Worktree stream was not subscribed before create")
      const event = { directory: "/worktree", payload: behavior.worktreeFails ? { type: "worktree.failed", properties: { message: "checkout failed" } } : { type: "worktree.ready", properties: { name: "worktree" } } }
      if (readyBeforeCreateReturns) emit(event)
      else setTimeout(() => emit(event), 1)
      return Response.json({ directory: "/worktree", name: "worktree", branch: "opencode/worktree" })
    }
    if (url.pathname === "/session" && request.method === "POST") {
      const child = { id: `ses_${children.length + 1}`, prompts: [], polls: 0, attempt: children.length }
      children.push(child)
      if (behavior.createDelayMs) await new Promise((resolve) => setTimeout(resolve, behavior.createDelayMs))
      return Response.json(child)
    }
    if (url.pathname === "/session/status") {
      if (behavior.hangStatus) return new Promise<Response>(() => {})
      const child = children.at(-1)!
      child.polls++
      const value = snapshot(child).status
      return Response.json(value ? { [child.id]: { type: value } } : {})
    }
    const child = children.find((entry) => url.pathname.startsWith(`/session/${entry.id}/`))!
    if (url.pathname.endsWith("/prompt_async")) { child.prompts.push(body); child.polls = 0; return new Response(null, { status: 204 }) }
    if (url.pathname.endsWith("/abort")) { aborted++; return Response.json(!behavior.abortFails) }
    if (url.pathname.endsWith("/message")) {
      const messages = snapshot(child).messages ?? []
      if (!behavior.formatEncodingBug) return Response.json(messages)
      const encodingError = () => Response.json({ name: "UnknownError", data: { message: typeof behavior.formatEncodingBug === "string" ? behavior.formatEncodingBug : 'Expected OutputFormatJsonSchema, actual {type:"json_schema"} at [0]["info"]["format"]' } }, { status: 500 })
      if (url.searchParams.get("limit") !== "1") return encodingError()
      const index = Number(url.searchParams.get("before") ?? messages.length) - 1
      if (index < 0) return Response.json([])
      if (index === 0 && messages[index].info.role === "user") return encodingError()
      return Response.json([messages[index]], { headers: index > 0 ? { "X-Next-Cursor": String(index) } : undefined })
    }
    throw new Error(`Unexpected request ${request.method} ${url.pathname}`)
  }) as typeof fetch })
  return { client, calls, children, get aborted() { return aborted }, readyEarly() { readyBeforeCreateReturns = true } }
}
const input = (client: AgentExecutionInput["client"], overrides: Partial<AgentExecutionInput> = {}): AgentExecutionInput => ({
  client, parentID: "ses_parent", directory: "/project", prompt: "Answer briefly", model: { providerID: "provider", modelID: "model" },
  options: { retries: 0, timeoutMs: 2_000 }, availableAgents: [{ name: "workflow-agent", mode: "subagent" }],
  polling: { intervalMs: 2, startGraceMs: 1_000, completionGraceMs: 1_000, retryDelayMs: 1 }, ...overrides,
})
const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false }

describe("agent lifecycle over the real v2 HTTP transport", () => {
  test("format fallback remembers an unreadable older cursor without hiding new assistant updates", async () => {
    const transport = fake(child => ({ status: child.polls < 5 ? "busy" : "idle",
      messages: [user(child), assistant(child, { structured: { answer: "ok" } })] }), { formatEncodingBug: true });
    const result = await executeAgent(input(transport.client, { options: { schema, retries: 0 } }));
    expect(result).toMatchObject({ status: "completed", value: { answer: "ok" } });
    expect(transport.calls.filter(call => call.limit === "1")).toHaveLength(6);
  });
  test("local response guards stop oversized streaming output even without supported provider limits", async () => {
    const transport = fake(child => ({ status: "busy", messages: [user(child), assistant(child, { time: { created: 2 } }, "x".repeat(200))] }));
    const result = await executeAgent(input(transport.client, { options: { retries: 2 }, responseLimits: { characters: 100, tokens: 1000 } }));
    expect(result).toMatchObject({ status: "failed", attempts: 1, failure: { kind: "output_limit" } });
    expect(transport.aborted).toBe(1);
  });

  test("local response size guard excludes tool results and preserves multi-step work", async () => {
    const transport = fake(child => {
      const running = child.polls < 8;
      const response = assistant(child, running ? { time: { created: 2 } } : {});
      response.parts.push({ id: "prt_tool", sessionID: child.id, messageID: response.info.id, type: "tool", callID: "call", tool: "bash",
        state: running ? { status: "running", input: { command: "long-test" }, time: { start: 1 } }
          : { status: "completed", input: { command: "long-test" }, output: "x".repeat(2000), title: "Long tool", metadata: {}, time: { start: 1, end: 2 } } });
      return { status: running ? "busy" : "idle", messages: [user(child), response] };
    });
    const result = await executeAgent(input(transport.client, { responseLimits: { characters: 1000, tokens: 1000 } }));
    expect(result.status).toBe("completed");
  });
  test("truncated model output is never accepted or retried in another paid child", async () => {
    const transport = fake(child => ({ messages: [user(child), assistant(child, { finish: "length" }, "unfinished answer")] }));
    const result = await executeAgent(input(transport.client, { options: { retries: 3, timeoutMs: 2000 } }));
    expect(result).toMatchObject({ status: "failed", value: null, attempts: 1, failure: { kind: "output_limit" } });
    expect(transport.children).toHaveLength(1);
  });
  test("quota exhaustion preserves the provider reset and does not start a retry child", async () => {
    const reset = Math.floor(Date.now() / 1000) + 7200;
    const transport = fake(child => ({ messages: [user(child), assistant(child, { error: { name: "APIError", data: {
      message: "The usage limit has been reached", statusCode: 429, isRetryable: true,
      responseBody: JSON.stringify({ error: { type: "usage_limit_reached", resets_at: reset } }),
    } } })] }));
    const result = await executeAgent(input(transport.client, { options: { retries: 3, timeoutMs: 2000 } }));
    expect(result.status).toBe("failed"); expect(result.attempts).toBe(1); expect(transport.children).toHaveLength(1);
    expect(result.failure).toMatchObject({ kind: "quota", statusCode: 429, retryAt: reset * 1000 });
  });
  test("child permissions preserve parent rules and tool flags cannot grant new access", async () => {
    const permission = [{ permission: "read", pattern: "private/*", action: "deny" }, { permission: "bash", pattern: "*", action: "ask" }]
    const transport = fake(undefined, { parentPermission: permission })
    await executeAgent(input(transport.client, { options: { tools: { read: true, edit: false, workflow: true } } }))
    const creation = transport.calls.find(call => call.pathname === "/session")!.body
    expect(creation.permission).toEqual([...permission, { permission: "edit", pattern: "*", action: "deny" },
      { permission: "workflow*", pattern: "*", action: "deny" }, { permission: "task", pattern: "*", action: "deny" }])
    expect(transport.calls.find(call => call.pathname.endsWith("/prompt_async"))!.body).not.toHaveProperty("tools")
  })
  test("requires idle after a completed response and counts usage only once", async () => {
    const transport = fake((child) => ({ status: child.polls < 3 ? "busy" : undefined, messages: [user(child), assistant(child)] }))
    const deltas: unknown[] = []
    const result = await executeAgent(input(transport.client, { onUsage: (usage) => deltas.push(usage), workflow: { runId: "run", agentId: "agent" } }))
    expect(result).toMatchObject({ status: "completed", value: "done", attempts: 1, usage: { input: 10, output: 4, reasoning: 2, cost: 0.01 } })
    expect(transport.children[0].polls).toBe(3)
    expect(deltas).toHaveLength(1)
    expect(transport.calls.find((call) => call.pathname === "/session")!.body.metadata.workflow).toEqual({ runId: "run", agentId: "agent" })
    expect(transport.calls.every((call) => call.directory === "/project")).toBe(true)
    const prompt = transport.calls.find((call) => call.pathname.endsWith("/prompt_async"))!.body
    expect(prompt.messageID).toMatch(/^msg_[a-f0-9]{26}$/)
    expect(prompt.model).toEqual({ providerID: "provider", modelID: "model" })
  })

  test("goal and workflow children retain the invoking primary agent's permission policy", async () => {
    const transport = fake()
    await executeAgent(input(transport.client, { availableAgents: [
      { name: "workflow-agent", mode: "subagent" },
      { name: "build", mode: "primary", permission: [{ permission: "edit", pattern: "protected/*", action: "deny" }] },
    ] }))
    expect(transport.calls.find(call => call.pathname === "/session")!.body.permission).toContainEqual({ permission: "edit", pattern: "protected/*", action: "deny" })
  })

  test("does not treat a retry or transient context error as terminal", async () => {
    const transport = fake((child) => ({ status: child.polls < 3 ? "retry" : "idle", messages: [user(child), assistant(child, child.polls < 3 ? { error: { name: "ContextOverflowError", data: { message: "compacting" } } } : {})] }))
    expect((await executeAgent(input(transport.client))).status).toBe("completed")
    expect(transport.aborted).toBe(0)
  })

  test("allows initial idle without our user message and ignores unrelated assistants", async () => {
    const transport = fake((child) => ({ messages: child.polls < 3 ? [assistant(child, { id: "msg_old", parentID: "msg_unrelated" })] : [user(child), assistant(child)] }))
    expect((await executeAgent(input(transport.client))).value).toBe("done")
    expect(transport.children[0].polls).toBe(3)
  })

  test("fails pre-loop idle after a bounded grace and retries in a fresh session", async () => {
    const transport = fake((child) => ({ messages: child.attempt === 0 ? [] : [user(child), assistant(child)] }))
    const result = await executeAgent(input(transport.client, { options: { retries: 1, timeoutMs: 2_000 }, polling: { intervalMs: 2, startGraceMs: 20, completionGraceMs: 20, retryDelayMs: 1 } }))
    expect(result.status).toBe("completed")
    expect(result.attempts).toBe(2)
    expect(transport.children.map((child) => child.id)).toEqual(["ses_1", "ses_2"])
    expect(transport.aborted).toBe(1)
  })

  test("rereads incomplete idle messages before deciding", async () => {
    const transport = fake((child) => ({ messages: [user(child), assistant(child, child.polls < 3 ? { time: { created: 2 } } : {})] }))
    expect((await executeAgent(input(transport.client))).status).toBe("completed")
  })

  test("a completed tool-only turn is not a final successful answer", async () => {
    const transport = fake((child) => ({ messages: [user(child), assistant(child, { finish: "tool-calls" })] }))
    expect(await executeAgent(input(transport.client, { polling: { intervalMs: 2, completionGraceMs: 20 } }))).toMatchObject({ status: "failed", value: null })
    expect(transport.aborted).toBe(1)
  })

  test("MessageAbortedError resolves skipped without retry, even with tool-calls finish", async () => {
    const transport = fake((child) => ({ messages: [user(child), assistant(child, { finish: "tool-calls", error: { name: "MessageAbortedError", data: { message: "User aborted" } } })] }))
    expect(await executeAgent(input(transport.client, { options: { retries: 2 } }))).toMatchObject({ status: "skipped", value: null, attempts: 1 })
  })

  test("interrupting provider retry can complete without finish or error and remains skipped", async () => {
    const transport = fake((child) => ({ messages: [user(child), assistant(child, { finish: undefined })] }))
    expect(await executeAgent(input(transport.client, { options: { retries: 2 } }))).toMatchObject({ status: "skipped", value: null, attempts: 1 })
  })

  test("failed assistant usage remains counted after a fresh successful attempt", async () => {
    const transport = fake((child) => ({ messages: [user(child), assistant(child, child.attempt === 0 ? { error: { name: "UnknownError", data: { message: "Transient failure" } } } : {})] }))
    const result = await executeAgent(input(transport.client, { options: { retries: 1 } }))
    expect(result).toMatchObject({ status: "completed", attempts: 2, usage: { input: 20, output: 8, reasoning: 4, cost: 0.02 } })
  })

  test("configuration errors throw without retries or launching an unknown agent", async () => {
    const transport = fake((child) => ({ messages: [user(child), assistant(child, { error: { name: "UnknownError", data: { message: "Model not found: provider/model" } } })] }))
    await expect(executeAgent(input(transport.client, { options: { retries: 3 } }))).rejects.toBeInstanceOf(AgentConfigurationError)
    expect(transport.children).toHaveLength(1)
    await expect(executeAgent(input(transport.client, { options: { agentType: "missing" } }))).rejects.toBeInstanceOf(AgentConfigurationError)
    expect(transport.children).toHaveLength(1)
  })

  test("timeout aborts the child and resolves failed", async () => {
    const transport = fake((child) => ({ status: "busy", messages: [user(child)] }))
    expect(await executeAgent(input(transport.client, { options: { timeoutMs: 15, retries: 2 } }))).toMatchObject({ status: "failed", value: null, error: "Agent timed out after 15 ms", attempts: 1 })
    expect(transport.aborted).toBe(1)
  })

  test("external skip aborts and resolves null; run cancellation aborts and throws", async () => {
    for (const name of ["AgentSkippedError", "RunAbortedError"]) {
      const controller = new AbortController()
      const reason = Object.assign(new Error("stop"), { name })
      let scheduled = false
      const transport = fake((child) => {
        if (!scheduled && child.polls > 0) { scheduled = true; setTimeout(() => controller.abort(reason), 0) }
        return { status: "busy", messages: [user(child)] }
      })
      const running = executeAgent(input(transport.client, { signal: controller.signal }))
      if (name === "AgentSkippedError") expect(await running).toMatchObject({ status: "skipped", value: null })
      else await expect(running).rejects.toBe(reason)
      expect(transport.aborted).toBe(1)
    }
  })

  test("pre-start skip rechecks idle and re-aborts a delayed busy child", async () => {
    const transport = fake((child) => ({ status: child.polls === 3 ? "busy" : "idle", messages: [user(child)] }))
    const controller = new AbortController()
    const result = await executeAgent(input(transport.client, {
      signal: controller.signal,
      onSession: () => { setTimeout(() => controller.abort(Object.assign(new Error("skip before runner starts"), { name: "AgentSkippedError" })), 0) },
    }))
    expect(result).toMatchObject({ status: "skipped", attempts: 1 })
    expect(transport.aborted).toBe(2)
    expect(transport.children[0].polls).toBeGreaterThanOrEqual(6)
  })

  test("skip reports an unconfirmed abort instead of claiming cleanup succeeded", async () => {
    const transport = fake((child) => ({ status: "busy", messages: [user(child)] }), { abortFails: true })
    const controller = new AbortController()
    const result = await executeAgent(input(transport.client, {
      signal: controller.signal,
      onSession: () => { setTimeout(() => controller.abort(Object.assign(new Error("skip"), { name: "AgentSkippedError" })), 5) },
    }))
    expect(result.status).toBe("skipped")
    expect(result.error).toContain("could not confirm child abort")
  })

  test("structured output is validated and corrected in the same session", async () => {
    const transport = fake((child) => ({ messages: [user(child), assistant(child, { finish: "tool-calls", structured: child.prompts.length === 1 ? { answer: 12 } : { answer: "valid" } })] }))
    const result = await executeAgent(input(transport.client, { options: { schema, retries: 0 } }))
    expect(result).toMatchObject({ status: "completed", value: { answer: "valid" }, attempts: 1 })
    expect(transport.children).toHaveLength(1)
    expect(transport.children[0].prompts).toHaveLength(2)
    expect(transport.children[0].prompts[1].parts[0].text).toContain("did not match")
    expect(transport.children[0].prompts[0].messageID < transport.children[0].prompts[1].messageID).toBe(true)
    expect(result.usage.output).toBe(8)
  })

  test("schema mismatch exhaustion fails after bounded correction attempts", async () => {
    const transport = fake((child) => ({ messages: [user(child), assistant(child, { structured: { answer: 12 } })] }))
    const result = await executeAgent(input(transport.client, { options: { schema, schemaRetries: 1, retries: 0 } }))
    expect(result.status).toBe("failed")
    expect(transport.children[0].prompts).toHaveLength(2)
  })

  test.each([true, 'Expected OutputFormatJsonSchema, got {"type":"json_schema","schema":{"properties":{... (416 more chars)'])
  ("OpenCode format encoding fallback pages assistant messages and waits through startup (%s)", async (formatEncodingBug) => {
    const transport = fake((child) => ({ messages: child.polls < 3 ? [user(child)] : [user(child), assistant(child, { finish: "tool-calls" }), assistant(child, { id: `${child.prompts[0].messageID}b`, structured: { answer: "valid" } })] }), { formatEncodingBug })
    const result = await executeAgent(input(transport.client, { options: { schema, retries: 0 } }))
    expect(result).toMatchObject({ status: "completed", value: { answer: "valid" }, usage: { input: 20, output: 8, reasoning: 4, cost: 0.02 } })
    expect(transport.children[0].polls).toBe(3)
    expect(transport.calls.filter((call) => call.pathname.endsWith("/message") && call.limit === null)).toHaveLength(1)
    expect(transport.aborted).toBe(0)
  })

  test("the compatibility fallback is restricted to native-schema children", async () => {
    const transport = fake(undefined, { formatEncodingBug: true })
    expect(await executeAgent(input(transport.client))).toMatchObject({ status: "failed" })
    expect(transport.calls.some((call) => call.limit === "1")).toBe(false)
  })

  test("a hanging status transport still obeys timeout and aborts the child", async () => {
    const transport = fake(undefined, { hangStatus: true })
    expect(await executeAgent(input(transport.client, { options: { timeoutMs: 15 } }))).toMatchObject({ status: "failed", attempts: 1 })
    expect(transport.aborted).toBe(1)
  })

  test("does not retry when abort cannot be confirmed", async () => {
    const transport = fake((child) => ({ messages: [user(child), assistant(child, { error: { name: "UnknownError", data: { message: "Transient failure" } } })] }), { abortFails: true })
    const result = await executeAgent(input(transport.client, { options: { retries: 2 } }))
    expect(result).toMatchObject({ status: "failed", attempts: 1 })
    expect(result.error).toContain("could not confirm child abort")
  })

  test("uncertain session creation is not retried and a late child is aborted", async () => {
    const transport = fake(undefined, { createDelayMs: 25 })
    const result = await executeAgent(input(transport.client, { options: { timeoutMs: 5, retries: 2 } }))
    expect(result).toMatchObject({ status: "failed", attempts: 1 })
    await new Promise((resolve) => setTimeout(resolve, 35))
    expect(transport.children).toHaveLength(1)
    expect(transport.aborted).toBe(1)
    expect(transport.children[0].prompts).toHaveLength(0)
  })

  test("persists session callback before dispatching a prompt", async () => {
    const transport = fake()
    let recorded = false
    const result = await executeAgent(input(transport.client, { onSession: async () => {
      await new Promise((resolve) => setTimeout(resolve, 2))
      expect(transport.children[0].prompts).toHaveLength(0)
      recorded = true
    } }))
    expect(recorded).toBe(true)
    expect(result.status).toBe("completed")
  })

  test("worktree waits for global readiness, routes every child call, and keeps the checkout", async () => {
    const transport = fake()
    transport.readyEarly()
    const result = await executeAgent(input(transport.client, { options: { isolation: "worktree", retries: 0 } }))
    expect(result).toMatchObject({ status: "completed", directory: "/worktree" })
    expect(transport.calls.filter((call) => call.pathname.startsWith("/session") && call.pathname !== "/session/ses_parent").every((call) => call.directory === "/worktree")).toBe(true)
    expect(transport.calls.find(call => call.pathname === "/session/ses_parent")?.directory).toBe("/project")
    expect(transport.calls.some((call) => call.method === "DELETE")).toBe(false)
  })

  test("failed worktree readiness retains its directory for recovery", async () => {
    const transport = fake(undefined, { worktreeFails: true })
    expect(await executeAgent(input(transport.client, { options: { isolation: "worktree", retries: 0 } }))).toMatchObject({ status: "failed", directory: "/worktree" })
    expect(transport.children).toHaveLength(0)
  })
})

describe("structured-output schema prevalidation", () => {
  test("supports nested arrays, enums, and required object properties", () => {
    const validator = validateSchema({ type: "object", properties: { values: { type: "array", items: { type: "integer", enum: [1, 2] } } }, required: ["values"] })
    expect(validator.safeParse({ values: [1, 2] }).success).toBe(true)
    expect(validator.safeParse({ values: [3] }).success).toBe(false)
  })

  test("rejects invalid roots, missing keys, impossible bounds, and enum contradictions before launch", async () => {
    const invalid: unknown[] = [
      { type: "array", items: { type: "string" } },
      { type: "object" },
      { type: "object", properties: {}, required: ["missing"] },
      { type: "object", properties: { n: { type: "number", minimum: 3, maximum: 1 } } },
      { type: "object", properties: { n: { type: "integer", minimum: 1.1, maximum: 1.9 } } },
      { type: "object", properties: { s: { type: "string", enum: [1, 2] } } },
      { type: "object", properties: {}, not: {} },
      { type: "object", properties: {}, allOf: [{ type: "array" }] },
      { type: "object", properties: {}, $async: true },
    ]
    const transport = fake()
    for (const bad of invalid) await expect(executeAgent(input(transport.client, { options: { schema: bad as Record<string, unknown> } }))).rejects.toBeInstanceOf(UnsatisfiableSchemaError)
    expect(transport.calls).toHaveLength(0)
  })

  test("preserves enum sibling constraints, deep const equality, and fields named enum", () => {
    const validator = validateSchema({ type: "object", properties: {
      enum: { type: "string", enum: ["allowed", 42] },
      deep: { const: { items: [1, 2] } },
    }, required: ["enum", "deep"] })
    expect(validator.safeParse({ enum: "allowed", deep: { items: [1, 2] } }).success).toBe(true)
    expect(validator.safeParse({ enum: 42, deep: { items: [1, 2] } }).success).toBe(false)
    expect(validator.safeParse({ enum: "allowed", deep: { items: [2, 1] } }).success).toBe(false)
  })

  test("validates untyped constraints, composition, formats, and local references", () => {
    const validator = validateSchema({ type: "object", properties: {
      email: { type: "string", format: "email" }, number: { $ref: "#/$defs/positive", maximum: 5 },
      conditional: { if: { type: "string" }, then: { minLength: 3 }, else: { type: "integer" } },
    }, $defs: { positive: { type: "integer", minimum: 1 } }, required: ["email", "number", "conditional"] })
    expect(validator.safeParse({ email: "test@example.com", number: 3, conditional: "abc" }).success).toBe(true)
    expect(validator.safeParse({ email: "invalid", number: 3, conditional: "abc" }).success).toBe(false)
    expect(validator.safeParse({ email: "test@example.com", number: 6, conditional: "abc" }).success).toBe(false)
    expect(validator.safeParse({ email: "test@example.com", number: 3, conditional: "a" }).success).toBe(false)
  })
})
