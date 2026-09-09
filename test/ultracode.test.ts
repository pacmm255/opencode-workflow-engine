import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultConfig, loadConfig, saveConfig } from "../src/core/config";
import { effectiveUltracode, exactUltracodeVariant, UltracodeSessionStore, ultracodeInstruction, ultracodeTrigger } from "../src/core/ultracode";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function trigger(text: string, extra: Partial<Parameters<typeof ultracodeTrigger>[0]> = {}) {
  return ultracodeTrigger({ role: "user", human: true, parts: [{ type: "text", text }],
    settings: { enabled: false, keyword: true, effort: null }, ...extra });
}

test.each(["ultracode build a mini game", "Build a mini game. ULTRACODE", "Can you fix the failing tests using ultracode?"])("human keyword opt-in: %s", text => {
  expect(trigger(text)).toMatchObject({ active: true, source: "keyword", task: text });
});
test.each([
  'Explain the word "ultracode"', "What does ultracode do?", "Here is an example: `ultracode build a game`",
  "```text\nultracode build a game\n```\nSummarize this example", "> ultracode build a game\nReview the quote",
  "    ultracode build a game", "Use the term ‘ultracode’ in the documentation", "Don't use ultracode. Fix this.",
  "Fix this without workflows", "Do not run a workflow", "Disable ultracode", "no workflow please",
  "Build myultracodewidget", "The keyword ultracode appears in this paragraph",
])("references, questions, and opt-outs do not trigger: %s", text => expect(trigger(text).active).toBe(false));
test("SDK, synthetic, ignored, child, and tool inputs cannot activate the keyword", () => {
  expect(trigger("ultracode build", { human: false }).active).toBe(false);
  expect(trigger("ultracode build", { parentID: "ses_parent" }).active).toBe(false);
  expect(trigger("ultracode build", { role: "assistant" }).active).toBe(false);
  expect(trigger("ultracode build", { parts: [{ type: "text", text: "ultracode build", synthetic: true }] }).active).toBe(false);
  expect(trigger("ultracode build", { parts: [{ type: "text", text: "ultracode build", ignored: true }] }).active).toBe(false);
  expect(trigger("ultracode build", { parts: [{ type: "text", text: "ultracode build" }, { type: "tool_result" }] }).active).toBe(false);
  expect(trigger("ultracode build", { optOut: true }).active).toBe(false);
});
test("keyword and explicit workflow-request opt-ins are separate from session mode", () => {
  const settings = { enabled: false, keyword: false, effort: null };
  expect(trigger("ultracode build", { settings }).active).toBe(false);
  expect(trigger("Use a workflow to build", { settings })).toMatchObject({ active: true, source: "workflow-request" });
  expect(trigger("Use a workflow to build", { settings, human: false }).active).toBe(false);
  expect(trigger("Build this", { settings: { ...settings, enabled: true } })).toMatchObject({ active: true, source: "session" });
  expect(trigger("Build this without workflows", { settings: { ...settings, enabled: true } }).active).toBe(false);
});
test("automatic mode supplies semantic judgment and scoped multi-stage continuation", () => {
  const text = ultracodeInstruction({ source: "session", effort: "xhigh" });
  expect(text).toContain("simple factual questions");
  expect(text).toContain("then implement, then verify");
  expect(text).toContain("Never automatically relaunch user-stopped");
  expect(text).toContain("configured allowed pool");
  expect(ultracodeInstruction({ source: "keyword" })).toContain("does not change session reasoning effort");
  expect(ultracodeInstruction({ source: "session", effort: null })).not.toContain("one-shot");
});
test("only exact effort variants are eligible", () => {
  expect(exactUltracodeVariant({ variants: ["high", "max"] }, "xhigh")).toBeUndefined();
  expect(exactUltracodeVariant({ variants: ["thinking"] }, "high")).toBeUndefined();
  expect(exactUltracodeVariant({ variants: ["xhigh"] }, "xhigh")).toBe("xhigh");
  expect(exactUltracodeVariant({ variants: ["high"] }, null)).toBeUndefined();
});
test("configuration persists by scope and session overrides take priority", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflow-ultracode-config-")); roots.push(root);
  const project = join(root, "project"), global = join(root, "config");
  await saveConfig(project, { ultracode: { enabled: true } }, "global", global);
  await saveConfig(project, { ultracode: { keyword: false } }, "project", global);
  const config = await loadConfig(project, global);
  expect(config.ultracode).toEqual({ enabled: true, keyword: false });
  expect(effectiveUltracode(config)).toEqual({ enabled: true, keyword: false, effort: "xhigh" });
  expect(effectiveUltracode(config, { enabled: false, effort: "high" })).toEqual({ enabled: false, keyword: false, effort: "high" });
  expect(effectiveUltracode(config, { enabled: true, effort: null }).effort).toBeNull();
  expect(defaultConfig.ultracode).toEqual({ enabled: false, keyword: true });
});
test("session preferences survive reload and remain isolated from other sessions and projects", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflow-ultracode-store-")); roots.push(root);
  const project = join(root, "project"), records = join(root, "records");
  const store = new UltracodeSessionStore(project, records);
  expect(await store.get("ses_one")).toBeUndefined();
  const value = await store.set("ses_one", { enabled: true, effort: "xhigh" });
  expect(await new UltracodeSessionStore(project, records).get("ses_one")).toEqual(value);
  expect(await store.get("ses_two")).toBeUndefined();
  expect(await new UltracodeSessionStore(join(root, "other"), records).get("ses_one")).toBeUndefined();
  expect((await stat(join(records, (await readdir(records))[0]!))).mode & 0o777).toBe(0o600);
  const next = await store.set("ses_one", { enabled: false, effort: null });
  expect(next.generation).not.toBe(value.generation);
  await store.clear("ses_one");
  expect(await store.get("ses_one")).toBeUndefined();
  expect(await readdir(records)).toEqual([]);
});
