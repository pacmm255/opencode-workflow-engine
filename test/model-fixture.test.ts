import { expect, test } from "bun:test";
import { PARENT_MARKER, startModelFixture } from "../e2e/fixture.ts";

test("offline fixture streams one workflow call and handles its result", async () => {
  const fixture = startModelFixture({ workflowInput: { script: "return 3" } });
  const tools = [{ type: "function", function: { name: "workflow", parameters: { type: "object" } } }];
  try {
    const result = await fetch(`${fixture.url}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fixture", stream: true, tools, messages: [{ role: "user", content: PARENT_MARKER }] }) });
    const events = (await result.text()).split("\n\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
    const deltas = events.flatMap(event => event.choices[0].delta.tool_calls ?? []);
    expect(deltas[0].function.name).toBe("workflow");
    expect(JSON.parse(deltas.map(delta => delta.function.arguments).join(""))).toEqual({ script: "return 3" });
    const response = await fetch(`${fixture.url}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tools, messages: [{ role: "user", content: PARENT_MARKER }, { role: "tool", tool_call_id: deltas[0].id, content: "done" }] }) });
    expect((await response.json() as any).choices[0].message.content).toBe("Fixture workflow finished.");
  } finally { fixture.stop(); }
});

test("offline fixture emits native structured-output calls and configurable child text", async () => {
  const fixture = startModelFixture({ childText: prompt => `reply:${prompt}`, structuredResult: { answer: 42 } });
  try {
    const call = async (tools: unknown[] = []) => {
      const response = await fetch(`${fixture.url}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "child" }], tools }) });
      return response.json() as Promise<any>;
    };
    expect((await call()).choices[0].message.content).toBe("reply:child");
    const structured = await call([{ type: "function", function: { name: "StructuredOutput", parameters: { type: "object", properties: { answer: { type: "integer" } } } } }]);
    expect(JSON.parse(structured.choices[0].message.tool_calls[0].function.arguments)).toEqual({ answer: 42 });
    expect(fixture.requests).toHaveLength(2);
  } finally { fixture.stop(); }
});
