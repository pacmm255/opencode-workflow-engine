import { randomBytes } from "node:crypto"
import { isAbsolute, relative, resolve } from "node:path"
import type { AssistantMessage, OpencodeClient, Part, PermissionRule, SessionMessagesResponse2 } from "@opencode-ai/sdk/v2"
import { validateSchema } from "./schema.ts"
import { executionFailure, type ExecutionFailure } from "./failure.ts"

export { UnsatisfiableSchemaError } from "./schema.ts"

export interface AgentUsage { input: number; output: number; reasoning: number; cost: number }
export interface AgentExecutionOptions {
  agentType?: string
  schema?: Record<string, unknown>
  system?: string
  tools?: Record<string, boolean>
  timeoutMs?: number
  retries?: number
  schemaRetries?: number
  isolation?: "worktree"
}
export interface AgentExecutionInput {
  client: OpencodeClient
  parentID: string
  directory: string
  prompt: string
  options: AgentExecutionOptions
  model: { providerID: string; modelID: string; variant?: string }
  signal?: AbortSignal
  availableAgents?: readonly { name: string; mode?: string; permission?: readonly PermissionRule[] }[]
  workflow?: { runId: string; agentId: string }
  protectedPaths?: readonly string[]
  /** Local safeguards for transports that cannot accept a wire-level output limit. Not a goal budget. */
  responseLimits?: { characters: number; tokens: number }
  onSession?: (sessionID: string, directory: string) => void | Promise<void>
  /** Deltas, including usage from failed attempts and aborted children. */
  onUsage?: (usage: AgentUsage) => void
  polling?: { intervalMs?: number; maxIntervalMs?: number; startGraceMs?: number; completionGraceMs?: number; retryDelayMs?: number }
}
export interface AgentExecutionResult {
  value: unknown
  status: "completed" | "failed" | "skipped"
  sessionID?: string
  directory?: string
  error?: string
  failure?: ExecutionFailure
  usage: AgentUsage
  attempts: number
}
export class AgentConfigurationError extends Error { override name = "AgentConfigurationError" }
class AgentTimeoutError extends Error { override name = "AgentTimeoutError" }
class AgentFailedError extends Error { override name = "AgentFailedError" }

const emptyUsage = (): AgentUsage => ({ input: 0, output: 0, reasoning: 0, cost: 0 })
const keys = ["input", "output", "reasoning", "cost"] as const
const message = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object") {
    const value = error as { name?: string; message?: string; data?: { message?: string } }
    return value.data?.message ?? value.message ?? JSON.stringify(error)
  }
  return String(error)
}
const isConfigurationError = (error: unknown): boolean => {
  const name = error && typeof error === "object" && "name" in error ? String(error.name) : ""
  return error instanceof AgentConfigurationError || /^(?:ProviderAuthError|NotGitError|AgentNotFoundError|ModelNotFoundError|ProviderModelNotFoundError)$/.test(name) || /(?:agent|model|provider).{0,60}(?:not found|unknown|unavailable|not configured)|(?:unknown|invalid|unsupported).{0,25}(?:agent|model|provider)/i.test(message(error))
}
const unwrap = <T>(result: { data?: T; error?: unknown }): T => {
  if (result.error) {
    if (isConfigurationError(result.error)) throw new AgentConfigurationError(message(result.error))
    throw new AgentFailedError(message(result.error), { cause: result.error })
  }
  return result.data as T
}
const abortReason = (signal: AbortSignal): Error => signal.reason instanceof Error ? signal.reason : new DOMException(String(signal.reason ?? "Aborted"), "AbortError")
// Large schemas truncate the host error before its trailing ["format"] path.
// This exact class name, on the message-read route, identifies the encoding bug.
const isFormatEncodingError = (error: unknown): boolean => /Expected OutputFormatJsonSchema/.test(message(error))
const messageOrder = (a: SessionMessagesResponse2[number], b: SessionMessagesResponse2[number]) =>
  a.info.time.created - b.info.time.created || (a.info.id < b.info.id ? -1 : a.info.id > b.info.id ? 1 : 0)
function cancellable<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(abortReason(signal)) }
    signal.addEventListener("abort", abort, { once: true })
    Promise.resolve(promise).then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value) },
      (error) => { signal.removeEventListener("abort", abort); reject(error) },
    )
  })
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortReason(signal)); return }
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(abortReason(signal)) }
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve() }, ms)
    signal.addEventListener("abort", abort, { once: true })
  })
}
let lastIDTime = 0
let idCounter = 0
function messageID(): string {
  const now = Math.max(Date.now(), lastIDTime)
  if (now !== lastIDTime) { lastIDTime = now; idCounter = 0 }
  if (++idCounter >= 4096) { lastIDTime++; idCounter = 0 }
  return `msg_${BigInt.asUintN(48, BigInt(lastIDTime) * 4096n + BigInt(idCounter)).toString(16).padStart(12, "0")}${randomBytes(7).toString("hex")}`
}

/** Worktree setup finishes asynchronously; a live, independent stream observes its boot result. */
async function createWorktree(input: AgentExecutionInput, signal: AbortSignal, onCreated: (directory: string) => void): Promise<string> {
  const streamController = new AbortController()
  const streamSignal = AbortSignal.any([signal, streamController.signal])
  let connected!: () => void
  let failed!: (error: unknown) => void
  const connection = new Promise<void>((resolve, reject) => { connected = resolve; failed = reject })
  const notices = new Map<string, { ready: boolean; error?: string }>()
  const pump = (async () => {
    const result = await input.client.global.event({ signal: streamSignal, sseMaxRetryAttempts: 1, sseDefaultRetryDelay: 0 })
    for await (const event of result.stream) {
      if (event.payload.type === "server.connected") connected()
      if (event.payload.type === "worktree.ready") notices.set(event.directory, { ready: true })
      if (event.payload.type === "worktree.failed") notices.set(event.directory, { ready: false, error: event.payload.properties.message })
    }
    if (!streamSignal.aborted) throw new AgentFailedError("Worktree event stream disconnected before readiness")
  })().catch((error: unknown) => { failed(error); if (!streamSignal.aborted) throw error })
  // Observe rejection immediately, including if it occurs while create() is in flight.
  void pump.catch(() => {})
  try {
    await cancellable(connection, signal)
    const tree = unwrap(await cancellable(input.client.worktree.create({ directory: input.directory, worktreeCreateInput: { name: `workflow-${randomBytes(4).toString("hex")}` } }, { signal }), signal))
    if (!tree?.directory) throw new AgentFailedError("Worktree creation returned no directory")
    onCreated(tree.directory)
    while (true) {
      const notice = notices.get(tree.directory)
      if (notice?.error) throw new AgentFailedError(`Worktree ${tree.directory} failed: ${notice.error}`)
      if (notice?.ready) return tree.directory
      await Promise.race([delay(input.polling?.intervalMs ?? 500, signal), pump.then(() => { throw new AgentFailedError("Worktree stream ended") })])
    }
  } finally {
    streamController.abort()
  }
}

/** Execute a fresh child per retry; session errors are interpreted only after idle. */
export async function executeAgent(input: AgentExecutionInput): Promise<AgentExecutionResult> {
  const { client, options } = input
  const validator = options.schema === undefined ? undefined : validateSchema(options.schema)
  const timeoutMs = options.timeoutMs ?? 300_000
  const retries = options.retries ?? 1
  const schemaRetries = options.schemaRetries ?? 2
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new AgentConfigurationError("timeoutMs must be positive and finite")
  for (const [name, value] of [["retries", retries], ["schemaRetries", schemaRetries]] as const) if (!Number.isSafeInteger(value) || value < 0 || value > 10) throw new AgentConfigurationError(`${name} must be an integer between 0 and 10`)
  if (!input.model.providerID || !input.model.modelID) throw new AgentConfigurationError("A resolved providerID and modelID are required")
  const agent = options.agentType ?? "workflow-agent"
  if (input.availableAgents) {
    const found = input.availableAgents.find((entry) => entry.name === agent)
    if (!found || found.mode === "primary") throw new AgentConfigurationError(`Agent ${agent} is unavailable as a subagent`)
  }
  const interval = input.polling?.intervalMs ?? 1_000
  const startGrace = input.polling?.startGraceMs ?? 15_000
  const completionGrace = input.polling?.completionGraceMs ?? 3_000
  const usage = emptyUsage()
  const seenUsage = new Map<string, AgentUsage>()
  let attempts = 0
  let sessionID: string | undefined
  let sessionCreationUncertain = false
  let messageAnchor: string | undefined
  const unreadableCursors = new Set<string>()
  let promptSubmitted = false
  let activityObserved = false
  let directory = input.directory
  let error: string | undefined
  let failure: ExecutionFailure | undefined
  const result = (status: AgentExecutionResult["status"], value: unknown = null): AgentExecutionResult => ({ value, status, sessionID, directory, error, ...(failure ? { failure } : {}), usage: { ...usage }, attempts })
  const account = (messages: SessionMessagesResponse2): void => {
    for (const entry of messages) {
      if (entry.info.role !== "assistant") continue
      const key = `${entry.info.sessionID}/${entry.info.id}`
      const prior = seenUsage.get(key) ?? emptyUsage()
      const next: AgentUsage = { input: entry.info.tokens.input, output: entry.info.tokens.output, reasoning: entry.info.tokens.reasoning, cost: entry.info.cost }
      const delta = emptyUsage()
      for (const key of keys) {
        next[key] = Math.max(prior[key], Number.isFinite(next[key]) ? next[key] : 0)
        delta[key] = next[key] - prior[key]
        usage[key] += delta[key]
      }
      seenUsage.set(key, next)
      if (keys.some((key) => delta[key])) input.onUsage?.(delta)
    }
    // Advance only after accounting: a parallel status request can fail after
    // history was read. Cleanup must still be able to collect that unseen usage.
    // Re-read the settled boundary itself and every in-flight reply next time.
    for (const entry of messages) {
      if (entry.info.role === "assistant" && entry.info.time.completed === undefined) break
      messageAnchor = entry.info.id
    }
  }
  const readMessages = async (signal: AbortSignal, userID?: string): Promise<SessionMessagesResponse2> => {
    if (!sessionID) return []
    const messages: SessionMessagesResponse2 = []
    const cursors = new Set<string>()
    const newestParents = new Set<string>()
    let before: string | undefined
    while (true) {
      if (before && unreadableCursors.has(before)) break
      const response = await cancellable(client.session.messages({ sessionID, directory, limit: 1, before }, { signal }), signal)
      // Single-message pages also avoid OpenCode's stored user.format encoding bug.
      // Only skip that exact encoding failure for a native-schema request.
      if (options.schema && response.error && isFormatEncodingError(response.error)) {
        if (before) unreadableCursors.add(before)
        break
      }
      const page = unwrap(response) ?? []
      for (const entry of [...page].sort((a, b) => messageOrder(b, a))) {
        if (entry.info.role !== "assistant") { messages.push(entry); continue }
        // Only the newest reply for a parent can be its final answer. Keep old
        // accounting metadata, not megabytes of historical tool output in RAM.
        if (newestParents.has(entry.info.parentID)) messages.push({ info: entry.info, parts: [] })
        else { newestParents.add(entry.info.parentID); messages.push(entry) }
      }
      if (page.some(entry => entry.info.id === messageAnchor || entry.info.id === userID)) break
      const cursor = response.response.headers.get("X-Next-Cursor")
      if (!cursor || !page.length) break
      if (cursors.has(cursor)) throw new AgentFailedError("OpenCode repeated a message pagination cursor")
      cursors.add(cursor)
      before = cursor
    }
    messages.sort(messageOrder)
    return messages
  }
  const stop = async (): Promise<boolean> => {
    if (!sessionID) return !sessionCreationUncertain
    const cleanup = AbortSignal.timeout(5_000)
    try {
      const stopped = unwrap(await cancellable(client.session.abort({ sessionID, directory }, { signal: cleanup }), cleanup))
      if (!stopped) return false
      if (promptSubmitted && !activityObserved) {
        // promptAsync can acknowledge before ensureRunning starts. Observe the
        // startup window after abort, and abort again if that delayed runner
        // becomes busy. All requests share the same bounded cleanup deadline.
        const observeUntil = Date.now() + Math.min(startGrace, 1_500)
        const interval = Math.min(100, Math.max(10, input.polling?.intervalMs ?? 100))
        let idleChecks = 0
        while (true) {
          await delay(interval, cleanup)
          const requestSignal = AbortSignal.any([cleanup, AbortSignal.timeout(500)])
          const statuses = unwrap(await cancellable(client.session.status({ directory }, { signal: requestSignal }), requestSignal))
          const status = statuses?.[sessionID]
          if (status && status.type !== "idle") {
            activityObserved = true
            idleChecks = 0
            if (!unwrap(await cancellable(client.session.abort({ sessionID, directory }, { signal: cleanup }), cleanup))) return false
          } else {
            idleChecks++
            if (idleChecks >= 3 && (activityObserved || Date.now() >= observeUntil)) break
          }
        }
      }
      try { account(await readMessages(cleanup)) } catch { /* Final usage is best effort if the server is unavailable. */ }
      return true
    } catch { return false }
  }
  const externalAbort = (): AgentExecutionResult | undefined => {
    if (!input.signal?.aborted) return
    const reason = abortReason(input.signal)
    if (reason.name === "AgentSkippedError") { error = error?.includes("could not confirm child abort") ? error : reason.message; return result("skipped") }
    if (error?.includes("could not confirm child abort")) throw Object.assign(new Error(`${reason.message}; could not confirm child abort`, { cause: reason }), { name: reason.name })
    throw reason
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    const cancelled = externalAbort()
    if (cancelled) return cancelled
    attempts++
    failure = undefined
    sessionID = undefined
    sessionCreationUncertain = false
    messageAnchor = undefined
    unreadableCursors.clear()
    seenUsage.clear()
    promptSubmitted = false
    activityObserved = false
    directory = input.directory
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new AgentTimeoutError(`Agent timed out after ${timeoutMs} ms`)), timeoutMs)
    const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal
    try {
      const parent = unwrap(await cancellable(client.session.get({ sessionID: input.parentID, directory: input.directory }, { signal }), signal))
      if (options.isolation === "worktree") directory = await createWorktree(input, signal, (createdDirectory) => { directory = createdDirectory })
      sessionCreationUncertain = true
      const creation = client.session.create({
        directory, parentID: input.parentID, title: `Workflow: ${input.prompt.slice(0, 80)}`, agent,
        model: { id: input.model.modelID, providerID: input.model.providerID, variant: input.model.variant },
        metadata: input.workflow ? { workflow: input.workflow } : undefined,
        permission: [...(input.availableAgents?.find(candidate => candidate.name === parent.agent)?.permission ?? []), ...(parent.permission ?? []),
          ...Object.entries(options.tools ?? {}).filter(([, enabled]) => !enabled).map(([permission]) => ({ permission, pattern: "*", action: "deny" as const })),
          ...(input.protectedPaths ?? []).flatMap(pattern => {
            const local = relative(input.directory, pattern)
            const paths = [pattern, ...(!isAbsolute(local) && local !== ".." && !local.startsWith("../") ? [resolve(directory, local)] : [])]
            return [...new Set(paths)].map(pattern => ({ permission: "edit", pattern, action: "deny" as const }))
          }),
          { permission: "workflow*", pattern: "*", action: "deny" }, { permission: "task", pattern: "*", action: "deny" }],
      }, { signal }).then(async (response) => {
        sessionCreationUncertain = false
        if (signal.aborted && response.data?.id) {
          // A transport may deliver its response after the deadline. Stop that
          // late child too; an uncertain create is never eligible for retry.
          const cleanup = AbortSignal.timeout(5_000)
          try { await cancellable(client.session.abort({ sessionID: response.data.id, directory }, { signal: cleanup }), cleanup) } catch { /* surfaced as an unconfirmed abort */ }
        }
        return response
      })
      const child = unwrap(await cancellable(creation, signal))
      if (!child?.id) throw new AgentFailedError("Child session creation returned no session ID")
      sessionID = child.id
      await cancellable(Promise.resolve(input.onSession?.(sessionID, directory)), signal)
      let prompt = input.prompt
      for (let correction = 0; correction <= schemaRetries; correction++) {
        const userID = messageID()
        promptSubmitted = true
        unwrap(await cancellable(client.session.promptAsync({
          sessionID, directory, messageID: userID, agent, model: input.model, variant: input.model.variant,
          // OpenCode's legacy tools map REPLACES session permissions. Keep the
          // inherited rules on the child; optional tool flags may only narrow them.
          system: options.system,
          format: options.schema ? { type: "json_schema", schema: options.schema } : undefined,
          parts: [{ type: "text", text: prompt }],
        }, { signal }), signal))
        const started = Date.now()
        let incompleteSince: number | undefined
        let final: { info: AssistantMessage; parts: Part[] } | undefined
        let last: { info: AssistantMessage; parts: Part[] } | undefined
        const parents = new Set([userID])
        let accepted = false
        let previousActivity = ""
        let quietPolls = 0
        const maxInterval = input.polling?.maxIntervalMs ?? Math.max(interval, Math.min(5000, interval * 5))
        while (!final) {
          const [statusResponse, messages] = await cancellable(Promise.all([
            client.session.status({ directory }, { signal }),
            readMessages(signal, userID),
          ]), signal)
          const statuses = unwrap(statusResponse)
          account(messages)
          signal.throwIfAborted()
          const status = statuses?.[sessionID]
          if (status && status.type !== "idle") activityObserved = true
          const ordered = messages
          const userIndex = ordered.findIndex((entry) => entry.info.role === "user" && entry.info.id === userID)
          if (userIndex !== -1) accepted = true
          for (const [index, entry] of ordered.entries()) {
            // Compaction may add a synthetic continuation or replay our exact
            // one-part prompt under a new user ID. Both remain our turn.
            if ((userIndex >= 0 ? index > userIndex : accepted || !!last) && entry.info.role === "user" && entry.parts.length && (entry.parts.every((part) => part.type === "text" && part.synthetic) || (entry.parts.length === 1 && entry.parts[0].type === "text" && entry.parts[0].text === prompt))) parents.add(entry.info.id)
            if (entry.info.role === "assistant" && parents.has(entry.info.parentID)
              && (!last || entry.info.time.created > last.info.time.created || entry.info.time.created === last.info.time.created && entry.info.id >= last.info.id))
              last = { info: entry.info, parts: entry.parts }
          }
          if (last) {
            activityObserved = true
            if (input.responseLimits) {
              const characters = last.parts.reduce((total, part) => total + (
                part.type === "text" || part.type === "reasoning" ? part.text.length
                  : part.type === "tool" ? (part.state.status === "pending" ? part.state.raw.length : JSON.stringify(part.state.input).length) : 0
              ), 0)
              if (characters > input.responseLimits.characters || last.info.tokens.output + last.info.tokens.reasoning > input.responseLimits.tokens)
                throw new AgentFailedError("Model exceeded the local per-response output length limit")
            }
          }
          if (!status || status.type === "idle") {
            if (last?.info.time.completed !== undefined && (last.info.finish !== "tool-calls" || last.info.error || last.info.structured !== undefined)) final = last
            else if (!last) {
              if (Date.now() - started >= startGrace) throw new AgentFailedError(!accepted ? "Child stayed idle without accepting the prompt (check agent/model configuration)" : "Child stayed idle without an assistant reply")
            } else {
              incompleteSince ??= Date.now()
              if (Date.now() - incompleteSince >= completionGrace) throw new AgentFailedError("Child became idle without completing its final assistant message")
            }
          } else incompleteSince = undefined
          if (!final) {
            const activity = JSON.stringify([status?.type, last?.info.id, last?.info.time.completed, last?.info.tokens,
              last?.parts.map(part => part.type === "text" || part.type === "reasoning" ? part.text.length : part.type === "tool" ? part.state.status : part.type)])
            quietPolls = activity === previousActivity && status?.type !== "idle" && status !== undefined ? quietPolls + 1 : 0
            previousActivity = activity
            await delay(Math.min(maxInterval, interval * 2 ** Math.min(quietPolls, 3)), signal)
          }
        }
        if (final.info.finish === "length" && final.info.error?.name !== "MessageAbortedError")
          throw new AgentFailedError("Model reached its output length limit before completing the task")
        if (final.info.error) {
          if (final.info.error.name === "MessageAbortedError") { error = message(final.info.error); return result("skipped") }
          if (isConfigurationError(final.info.error)) throw new AgentConfigurationError(message(final.info.error))
          throw new AgentFailedError(message(final.info.error), { cause: final.info.error })
        }
        if (!final.info.finish && final.info.structured === undefined) {
          error = "Child stopped before producing a final answer"
          return result("skipped")
        }
        if (validator) {
          const checked = validator.safeParse(final.info.structured)
          if (checked.success) { error = undefined; return result("completed", final.info.structured) }
          const details = checked.error.issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`).join("; ")
          if (correction === schemaRetries) throw new AgentFailedError(`Structured output did not match schema: ${details}`)
          prompt = `Your StructuredOutput did not match the required schema: ${details}. Call StructuredOutput again with corrected arguments.`
          continue
        }
        error = undefined
        return result("completed", final.info.structured ?? [...final.parts].reverse().find((part) => part.type === "text")?.text ?? "")
      }
    } catch (caught) {
      error = message(caught)
      failure = executionFailure(caught)
      const stopped = await stop()
      if (!stopped) error += "; could not confirm child abort, so no retry was started"
      const cancelled = externalAbort()
      if (cancelled) return cancelled
      if (isConfigurationError(caught)) throw caught instanceof AgentConfigurationError ? caught : new AgentConfigurationError(error)
      if (!stopped) return result("failed")
      // These require a cooldown or configuration/user action, not a fresh paid child.
      if (failure && ["quota", "rate_limit", "permission", "authentication", "configuration", "output_limit"].includes(failure.kind)) return result("failed")
      if (caught instanceof AgentTimeoutError) return result("failed")
      if (attempt === retries) return result("failed")
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
    try {
      await delay(input.polling?.retryDelayMs ?? Math.min(1_000 * 2 ** attempt, 5_000), input.signal ?? new AbortController().signal)
    } catch (caught) {
      const cancelled = externalAbort()
      if (cancelled) return cancelled
      throw caught
    }
  }
  return result("failed")
}
