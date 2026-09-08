import { describe, expect, test } from "bun:test";
import type { Provider, ProviderListResponse } from "@opencode-ai/sdk/v2/types";
import { defaultConfig, type WorkflowConfig } from "../src/core/config.ts";
import {
  catalogFromProviders, modelDescription, ModelNotAllowedError, ModelUnavailableError,
  resolveModel, VariantNotFoundError, type ModelEntry,
} from "../src/core/models.ts";

function config(): WorkflowConfig { return structuredClone(defaultConfig); }
function model(providerID: string, modelID: string, variants: string[] = []): ModelEntry {
  return { id: `${providerID}/${modelID}`, providerID, modelID, name: modelID, providerName: providerID, variants, toolcall: true };
}
const catalog = [
  model("openai", "gpt-5.6", ["low", "medium", "high", "xhigh"]),
  model("openrouter", "openai/gpt-5.6", ["high", "max"]),
  model("openrouter", "anthropic/claude-sonnet-4", ["high", "max"]),
  model("other", "plain"),
];
const sessionModel = { providerID: "openai", modelID: "gpt-5.6", variant: "high" };

describe("connected model catalog", () => {
  const provider = {
    id: "openrouter", name: "OpenRouter",
    models: { "anthropic/claude-sonnet-4": {
      id: "different-upstream-id", name: "Sonnet", variants: { high: {}, max: {}, default: {} }, capabilities: { toolcall: true },
    } },
  } as unknown as Provider;
  test("uses connected provider entries and preserves slash-bearing map keys", () => {
    const snapshot = { all: [provider, { ...provider, id: "disconnected" }], connected: ["openrouter"], default: {} } as ProviderListResponse;
    expect(catalogFromProviders(snapshot)).toEqual([{
      id: "openrouter/anthropic/claude-sonnet-4", providerID: "openrouter", modelID: "anthropic/claude-sonnet-4",
      name: "Sonnet", providerName: "OpenRouter", variants: ["high", "max"], toolcall: true,
    }]);
  });
  test("accepts config.providers filtered snapshots without an auth-only connected list", () => {
    expect(catalogFromProviders({ providers: [provider] })).toEqual(catalogFromProviders([provider]));
  });
});

describe("model resolution", () => {
  test("defaults to the exact invoking session model and variant", () => {
    expect(resolveModel({ config: config(), catalog, sessionModel })).toEqual(sessionModel);
  });
  test("resolves exact references with several slashes", () => {
    expect(resolveModel({ config: config(), catalog, sessionModel, requested: "openrouter/anthropic/claude-sonnet-4" }))
      .toEqual({ providerID: "openrouter", modelID: "anthropic/claude-sonnet-4" });
  });
  test("resolves bare IDs, slash-bearing bare IDs, and unique suffixes", () => {
    expect(resolveModel({ config: config(), catalog, sessionModel, requested: "gpt-5.6" })).toEqual(sessionModel);
    expect(resolveModel({ config: config(), catalog, sessionModel, requested: "anthropic/claude-sonnet-4" }).providerID).toBe("openrouter");
    expect(resolveModel({ config: config(), catalog, sessionModel, requested: "SONNET-4" }).modelID).toBe("anthropic/claude-sonnet-4");
  });
  test("rejects ambiguous bare IDs with explicit candidates", () => {
    const ambiguous = [...catalog, model("second", "gpt-5.6")];
    expect(() => resolveModel({ config: config(), catalog: ambiguous, sessionModel, requested: "gpt-5.6" })).toThrow("openai/gpt-5.6, second/gpt-5.6");
  });
  test("rejects unknown names and does not invent aliases for short names", () => {
    expect(() => resolveModel({ config: config(), catalog, sessionModel, requested: "sonnet" })).toThrow(ModelUnavailableError);
    expect(() => resolveModel({ config: config(), catalog, sessionModel, requested: "" })).toThrow(ModelUnavailableError);
  });
  test("aliases match exact raw names before full model IDs", () => {
    const cfg = config();
    cfg.models.aliases = { fast: "other/plain", "openai/gpt-5.6": "other/plain", constructor: "other/plain" };
    expect(resolveModel({ config: cfg, catalog, sessionModel, requested: "fast" }).modelID).toBe("plain");
    expect(resolveModel({ config: cfg, catalog, sessionModel, requested: "openai/gpt-5.6" }).modelID).toBe("plain");
    expect(resolveModel({ config: cfg, catalog, sessionModel, requested: "constructor" }).modelID).toBe("plain");
    expect(resolveModel({ config: cfg, catalog, sessionModel })).toEqual(sessionModel);
    cfg.models.default = "openai/gpt-5.6";
    expect(resolveModel({ config: cfg, catalog, sessionModel })).toEqual(sessionModel);
    expect(resolveModel({ config: cfg, catalog, sessionModel, agentModel: "openai/gpt-5.6" })).toEqual(sessionModel);
  });
  test("precedence is requested, explicitly selected agent, configured default, session", () => {
    const cfg = config();
    cfg.models.default = "other/plain";
    expect(resolveModel({ config: cfg, catalog, sessionModel }).modelID).toBe("plain");
    expect(resolveModel({ config: cfg, catalog, sessionModel, agentModel: "openrouter/anthropic/claude-sonnet-4" }).providerID).toBe("openrouter");
    expect(resolveModel({ config: cfg, catalog, sessionModel, agentModel: "other/plain", requested: "openai/gpt-5.6" })).toEqual(sessionModel);
  });
  test("unavailable configured default warns and falls back to the session", () => {
    const cfg = config();
    cfg.models.default = "missing/model";
    const warnings: string[] = [];
    expect(resolveModel({ config: cfg, catalog, sessionModel, onWarning: (warning) => warnings.push(warning) })).toEqual(sessionModel);
    expect(warnings.join(" ")).toContain("using session model");
  });
  test("unavailable explicit or agent model fails without falling back", () => {
    expect(() => resolveModel({ config: config(), catalog, sessionModel, requested: "missing/model" })).toThrow(ModelUnavailableError);
    expect(() => resolveModel({ config: config(), catalog, sessionModel, agentModel: "missing/model" })).toThrow(ModelUnavailableError);
    expect(() => resolveModel({ config: config(), catalog: [], sessionModel })).toThrow(ModelUnavailableError);
  });
  test("strict empty pool permits inheritance but denies explicit overrides", () => {
    const cfg = config();
    cfg.models.strict = true;
    expect(resolveModel({ config: cfg, catalog, sessionModel })).toEqual(sessionModel);
    expect(() => resolveModel({ config: cfg, catalog, sessionModel, requested: "openai/gpt-5.6" })).toThrow(ModelNotAllowedError);
    cfg.models.default = "other/plain";
    expect(resolveModel({ config: cfg, catalog, sessionModel }).modelID).toBe("plain");
  });
  test("strict pool checks canonical IDs after resolving aliases and agent settings", () => {
    const cfg = config();
    cfg.models.strict = true;
    cfg.models.allowed = ["openai/gpt-5.6"];
    cfg.models.aliases = { fast: "other/plain", strong: "openai/gpt-5.6" };
    expect(resolveModel({ config: cfg, catalog, sessionModel, requested: "strong" })).toEqual(sessionModel);
    expect(resolveModel({ config: cfg, catalog, sessionModel, requested: "gpt-5.6" })).toEqual(sessionModel);
    expect(() => resolveModel({ config: cfg, catalog, sessionModel, requested: "fast" })).toThrow(ModelNotAllowedError);
    expect(() => resolveModel({ config: cfg, catalog, sessionModel, agentModel: "other/plain" })).toThrow(ModelNotAllowedError);
  });
  test("provider/model/variant works but exact model IDs win over variant parsing", () => {
    const cfg = config();
    expect(resolveModel({ config: cfg, catalog, sessionModel, requested: "openrouter/anthropic/claude-sonnet-4/max" }).variant).toBe("max");
    const withSlash = [...catalog, model("openai", "gpt-5.6/high")];
    expect(resolveModel({ config: cfg, catalog: withSlash, sessionModel, requested: "openai/gpt-5.6/high" }).modelID).toBe("gpt-5.6/high");
  });
});

describe("model variants", () => {
  test("explicit variants override effort and unknown variants fail", () => {
    expect(resolveModel({ config: config(), catalog, sessionModel, variant: "low", effort: "max" }).variant).toBe("low");
    expect(() => resolveModel({ config: config(), catalog, sessionModel, variant: "max" })).toThrow(VariantNotFoundError);
    expect(resolveModel({ config: config(), catalog, sessionModel, variant: "default", effort: "max" }).variant).toBeUndefined();
  });
  test("effort maps to nearest known variant, ties upward, with a warning", () => {
    const warnings: string[] = [];
    expect(resolveModel({ config: config(), catalog, sessionModel, effort: "max", onWarning: (warning) => warnings.push(warning) }).variant).toBe("xhigh");
    expect(warnings).toHaveLength(1);
    expect(resolveModel({ config: config(), catalog, sessionModel, requested: "openrouter/anthropic/claude-sonnet-4", effort: "xhigh" }).variant).toBe("max");
    expect(resolveModel({ config: config(), catalog, sessionModel, requested: "openrouter/anthropic/claude-sonnet-4", effort: "low" }).variant).toBe("high");
  });
  test("models without ordinal variants drop effort and warn; custom variants remain explicit", () => {
    const custom = [model("custom", "toggle", ["none", "thinking", "fast"])];
    const warnings: string[] = [];
    const opts = { config: config(), catalog: custom, sessionModel: { providerID: "custom", modelID: "toggle" } };
    expect(resolveModel({ ...opts, effort: "high", onWarning: (warning) => warnings.push(warning) }).variant).toBeUndefined();
    expect(warnings.join(" ")).toContain("no supported reasoning variant");
    expect(resolveModel({ ...opts, variant: "thinking" }).variant).toBe("thinking");
  });
  test("configured effort applies unless overridden", () => {
    const cfg = config();
    cfg.defaults.effort = "low";
    expect(resolveModel({ config: cfg, catalog, sessionModel }).variant).toBe("low");
    expect(resolveModel({ config: cfg, catalog, sessionModel, effort: "high" }).variant).toBe("high");
  });
  test("session variant never leaks into another model and default sentinel is omitted", () => {
    expect(resolveModel({ config: config(), catalog, sessionModel, requested: "openrouter/anthropic/claude-sonnet-4" }).variant).toBeUndefined();
    expect(resolveModel({ config: config(), catalog, sessionModel: { ...sessionModel, variant: "default" } }).variant).toBeUndefined();
  });
  test("invalid inherited variant is dropped with a warning", () => {
    const warnings: string[] = [];
    expect(resolveModel({ config: config(), catalog, sessionModel: { ...sessionModel, variant: "retired" }, onWarning: (warning) => warnings.push(warning) }).variant).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });
});

test("description exposes exact IDs, variants, stale choices, strict policy, and advisory size", () => {
  const cfg = config();
  cfg.models.allowed = ["openai/gpt-5.6", "missing/model"];
  cfg.models.aliases = { fast: "other/plain", gone: "missing/model" };
  cfg.models.strict = true;
  const description = modelDescription(cfg, catalog);
  expect(description).toContain("openai/gpt-5.6");
  expect(description).toContain("WARNING: unavailable");
  expect(description).toContain("target outside strict pool");
  expect(description).toContain("at most 15 agents");
  cfg.sizeGuideline = null;
  expect(modelDescription(cfg, catalog)).not.toContain("Workflow size guideline");
});
