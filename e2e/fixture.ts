export interface FixtureMessage {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
}

export interface FixtureRequest {
  model?: string;
  messages: FixtureMessage[];
  tools?: Array<{ type: string; function: { name: string; parameters?: Record<string, unknown> } }>;
  stream?: boolean;
  [key: string]: unknown;
}

export interface ModelFixtureOptions {
  workflowInput?: Record<string, unknown>;
  parentToolName?: string;
  childText?: string | ((prompt: string) => string);
  structuredResult?: Record<string, unknown> | ((schema: Record<string, unknown>, prompt: string) => Record<string, unknown>);
  childDelayMs?: number | ((prompt: string) => number);
}

/** Include this marker in the parent prompt; children never need to know it. */
export const PARENT_MARKER = "WORKFLOW_FIXTURE_PARENT";

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(part => typeof part?.text === "string" ? part.text : "").join("\n");
  return "";
}

function schemaExample(schema: Record<string, unknown>): unknown {
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if ("default" in schema) return schema.default;
  const kind = Array.isArray(schema.type) ? schema.type.find(value => value !== "null") : schema.type;
  switch (kind) {
    case "object": return Object.fromEntries(Object.entries((schema.properties ?? {}) as Record<string, Record<string, unknown>>).map(([key, value]) => [key, schemaExample(value)]));
    case "array": return Array.from({ length: Math.min(10, Number(schema.minItems ?? 1)) }, () => schemaExample((schema.items ?? {}) as Record<string, unknown>));
    case "integer": case "number": return Math.max(1, Number(schema.minimum ?? 1));
    case "boolean": return true;
    case "null": return null;
    default: return "fixture";
  }
}

/** An offline OpenAI-compatible endpoint for real OpenCode integration tests. */
export function startModelFixture(options: ModelFixtureOptions = {}) {
  const requests: FixtureRequest[] = [];
  let sequence = 0;
  let workflowInput = options.workflowInput ?? { script: "return await agent('fixture child')" };
  let parentToolName = options.parentToolName ?? "workflow";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 120,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "fixture-model", object: "model", created: 0, owned_by: "workflow-tests" }] });
      if (!path.endsWith("/chat/completions")) return Response.json({ error: { message: `Unsupported fixture endpoint: ${path}` } }, { status: 404 });
      const body = await request.json() as FixtureRequest;
      requests.push(body);
      if (!Array.isArray(body.messages)) return Response.json({ error: { message: "messages must be an array" } }, { status: 400 });
      const tools = body.tools ?? [];
      const workflowTool = tools.find(tool => tool.function.name === parentToolName);
      const structuredTool = tools.find(tool => tool.function.name === "StructuredOutput");
      const userMessages = body.messages.filter(message => message.role === "user");
      const prompt = textContent(userMessages.at(-1)?.content);
      const parent = !!workflowTool && userMessages.some(message => textContent(message.content).includes(PARENT_MARKER));
      const hasWorkflowResult = body.messages.some(message => message.role === "tool" && message.tool_call_id?.startsWith("fixture_workflow_"));
      let toolCall: { name: string; arguments: string; id: string } | undefined;
      let content: string | undefined;
      const index = ++sequence;
      if (parent && !hasWorkflowResult) {
        toolCall = { name: workflowTool!.function.name, arguments: JSON.stringify(workflowInput), id: `fixture_workflow_${index}` };
      } else if (parent) content = "Fixture workflow finished.";
      else {
        const delay = typeof options.childDelayMs === "function" ? options.childDelayMs(prompt) : options.childDelayMs ?? 0;
        if (delay > 0) await Bun.sleep(delay);
        if (structuredTool) {
          const schema = structuredTool.function.parameters ?? {};
          const value = typeof options.structuredResult === "function" ? options.structuredResult(schema, prompt) : options.structuredResult ?? schemaExample(schema);
          toolCall = { name: structuredTool.function.name, arguments: JSON.stringify(value), id: `fixture_structured_${index}` };
        } else content = typeof options.childText === "function" ? options.childText(prompt) : options.childText ?? "fixture child reply";
      }
      const base = { id: `chatcmpl-fixture-${index}`, created: 1_700_000_000, model: body.model ?? "fixture-model" };
      const usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };
      const finishReason = toolCall ? "tool_calls" : "stop";
      if (!body.stream) return Response.json({
        ...base, object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: content ?? null, ...(toolCall ? { tool_calls: [{ id: toolCall.id, type: "function", function: { name: toolCall.name, arguments: toolCall.arguments } }] } : {}) }, finish_reason: finishReason }], usage,
      });
      const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null, extra: Record<string, unknown> = {}) => `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`;
      const events = [chunk({ role: "assistant", content: "" })];
      if (toolCall) {
        events.push(chunk({ tool_calls: [{ index: 0, id: toolCall.id, type: "function", function: { name: toolCall.name, arguments: "" } }] }));
        // Split arguments so integration also exercises incremental tool-call parsing.
        const middle = Math.floor(toolCall.arguments.length / 2);
        events.push(chunk({ tool_calls: [{ index: 0, function: { arguments: toolCall.arguments.slice(0, middle) } }] }));
        events.push(chunk({ tool_calls: [{ index: 0, function: { arguments: toolCall.arguments.slice(middle) } }] }));
      } else events.push(chunk({ content }));
      events.push(chunk({}, finishReason, { usage }));
      events.push("data: [DONE]\n\n");
      return new Response(events.join(""), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
    },
  });
  return {
    url: server.url.origin,
    requests,
    setWorkflowInput(input: Record<string, unknown>): void { workflowInput = input; },
    setToolCall(name: string, input: Record<string, unknown>): void { parentToolName = name; workflowInput = input; },
    stop(): void { void server.stop(true); },
  };
}
