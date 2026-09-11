import { describe, expect, test } from "bun:test";
import type { Agent } from "@opencode-ai/sdk/v2/types";
import { agentDescription, catalogFromAgents, planningGuidance } from "../src/core/agents.ts";
import { defaultConfig } from "../src/core/config.ts";
import type { ModelEntry } from "../src/core/models.ts";

function agent(name: string, extra: Partial<Agent> = {}): Agent {
  return { name, mode: "subagent", permission: [], options: {}, ...extra };
}
const models: ModelEntry[] = [{ id: "demo/reviewer", providerID: "demo", modelID: "reviewer",
  name: "Reviewer", providerName: "Demo", variants: ["high"], toolcall: true }];

describe("configured subagent planning catalog", () => {
  test("includes hidden subagents and all-mode agents, excludes primary-only agents", () => {
    const entries = catalogFromAgents([
      agent("workflow-agent", { hidden: true }), agent("primary", { mode: "primary" }), agent("explorer", { mode: "all" }),
    ]);
    expect(entries.map((entry) => entry.name)).toEqual(["explorer", "workflow-agent"]);
    expect(entries.find((entry) => entry.name === "workflow-agent")?.hidden).toBe(true);
  });
  test("exposes the configured description and exact model without private prompts or options", () => {
    const configured = agent("reviewer", { description: "Review correctness", model: { providerID: "demo", modelID: "reviewer" },
      variant: "high", prompt: "private-system-prompt", options: { apiKey: "private-api-key" } });
    expect(catalogFromAgents([configured])).toEqual([{ name: "reviewer", description: "Review correctness", mode: "subagent", hidden: false,
      model: { providerID: "demo", modelID: "reviewer", variant: "high" } }]);
    expect(JSON.stringify(catalogFromAgents([configured]))).not.toContain("private");
  });
  test("warns about unavailable defaults and strict agent models without hiding usable agent types", () => {
    const cfg = structuredClone(defaultConfig);
    cfg.models.strict = true;
    const description = agentDescription(cfg, models, [agent("reviewer", { model: { providerID: "demo", modelID: "reviewer" } }),
      agent("gone", { model: { providerID: "missing", modelID: "model" } })]);
    expect(description).toContain("default agent workflow-agent is not available");
    expect(description).toContain("reviewer:");
    expect(description).toContain("allowed explicit model override is required");
    expect(description).toContain("configured model is unavailable");
    expect(description).toContain("not an independent permission allowlist");
    expect(description).toContain("never grants permissions");
  });
  test("advisory pool still restricts autonomous agent-model inheritance unless the user requested it", () => {
    const cfg = structuredClone(defaultConfig);
    cfg.models.allowed = ["demo/reviewer"];
    const description = agentDescription(cfg, models, [agent("specialist", { model: { providerID: "other", modelID: "model" } })]);
    expect(description).toContain("outside the autonomous pool");
    expect(description).toContain("unless the user requested this model");
    expect(description).not.toContain("outside the strict pool");
  });
  test("planning chooses a task-sized team, preserves explicit choices, and requires assignment reasons", () => {
    const config = structuredClone(defaultConfig);
    config.limits.maxConcurrency = 1;
    const guidance = planningGuidance(config, models, [agent("workflow-agent")]);
    expect(guidance).toContain("Honor explicit user choices");
    expect(guidance).toContain("smallest sufficient team");
    expect(guidance).toContain("one focused agent can be enough");
    expect(guidance).toContain("do not fill the size guideline");
    expect(guidance).toContain("brief reason explaining why");
    expect(guidance).toContain("why the additional assignment is needed");
    expect(guidance).toContain("parallelize only independent tasks");
    expect(guidance).toContain("Per-run workflow child concurrency limit: 1.");
    expect(guidance).toContain("Use dependsOn to serialize builds, tests, and profilers");
    expect(guidance).toContain("Respect project-specific build/thread limits");
    expect(guidance).toContain("resource savings never justify skipping acceptance checks");
    expect(guidance).toContain("Primary-only agents cannot");
  });
});
