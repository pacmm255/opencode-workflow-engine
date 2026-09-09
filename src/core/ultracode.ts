import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { WorkflowConfig } from "./config.ts";
import { failure } from "./errors.ts";
import type { ModelEntry } from "./models.ts";
import { runsDirectory } from "./paths.ts";

export type UltracodeEffort = "high" | "xhigh";
export type UltracodeSessionOverride = { enabled: boolean; effort?: UltracodeEffort | null; generation?: string };
export type UltracodeSettings = { enabled: boolean; keyword: boolean; effort: UltracodeEffort | null };
export const ultracodeOriginKey = "workflowOrigin";
export const ultracodeOptOutKey = "workflowOptOut";
export const workflowResultKey = "workflowResult";
export type UltracodeRequest = {
  messageID: string; task: string; source: "session" | "keyword" | "workflow-request";
  effort: UltracodeEffort | null;
  generation?: string;
};

const overrideSchema = z.strictObject({ enabled: z.boolean(), effort: z.enum(["high", "xhigh"]).nullable().optional(), generation: z.string().optional() });
const recordSchema = z.strictObject({
  version: z.literal(1), directory: z.string(), sessionID: z.string(), value: overrideSchema,
});
const writes = new Map<string, Promise<unknown>>();

/** Private per-project/session preferences. This never writes workflow or OpenCode configuration. */
export class UltracodeSessionStore {
  private readonly directory: string;
  private readonly root: string;

  constructor(directory: string, root = join(dirname(runsDirectory()), "ultracode-sessions")) {
    this.directory = resolve(directory);
    this.root = resolve(root);
  }

  private file(sessionID: string): string {
    if (!sessionID.trim() || sessionID.length > 1000) throw failure("UltracodeStateError", "Invalid session ID");
    const key = createHash("sha256").update(this.directory).update("\0").update(sessionID).digest("hex");
    return join(this.root, `${key}.json`);
  }

  async get(sessionID: string): Promise<UltracodeSessionOverride | undefined> {
    const file = this.file(sessionID);
    let handle;
    try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 16_384) throw failure("UltracodeStateError", "Invalid session preference record");
      const parsed = recordSchema.safeParse(JSON.parse(await handle.readFile("utf8")));
      if (!parsed.success || parsed.data.directory !== this.directory || parsed.data.sessionID !== sessionID)
        throw failure("UltracodeStateError", "Session preference record does not match this project and session");
      return parsed.data.value;
    } finally { await handle.close(); }
  }

  private async write<T>(file: string, operation: () => Promise<T>): Promise<T> {
    const previous = writes.get(file) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(operation);
    writes.set(file, pending);
    try { return await pending; }
    finally { if (writes.get(file) === pending) writes.delete(file); }
  }

  async set(sessionID: string, value: UltracodeSessionOverride): Promise<UltracodeSessionOverride> {
    const validated = { ...overrideSchema.parse(value), generation: randomUUID() };
    const file = this.file(sessionID);
    return this.write(file, async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, "wx", 0o600);
        try { await handle.writeFile(`${JSON.stringify({ version: 1, directory: this.directory, sessionID, value: validated })}\n`); }
        finally { await handle.close(); }
        await rename(temporary, file);
      } finally {
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      }
      return validated;
    });
  }

  async clear(sessionID: string): Promise<void> {
    const file = this.file(sessionID);
    await this.write(file, async () => {
      await unlink(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    });
  }
}

export function effectiveUltracode(config: WorkflowConfig, override?: UltracodeSessionOverride): UltracodeSettings {
  const enabled = override?.enabled ?? config.ultracode.enabled;
  return { enabled, keyword: config.ultracode.keyword,
    effort: override && Object.hasOwn(override, "effort") ? override.effort ?? null : enabled ? "xhigh" : null };
}

/** Exact means exact: never translate xhigh into max, thinking, or another variant. */
export function exactUltracodeVariant(model: Pick<ModelEntry, "variants">, effort: UltracodeEffort | null): UltracodeEffort | undefined {
  return effort !== null && model.variants.includes(effort) ? effort : undefined;
}

export type UltracodeTriggerPart = { type: string; text?: string; synthetic?: boolean; ignored?: boolean };
export type UltracodeTrigger = { active: boolean; source?: "session" | "keyword" | "workflow-request"; task: string };

/** Remove quoted/reference material only for matching; the actual task is never rewritten. */
function matchingText(text: string): string {
  let fence: string | undefined;
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      lines.push("");
      continue;
    }
    lines.push(fence || /^\s*>/.test(line) || /^(?: {4}|\t)/.test(line) ? "" : line);
  }
  return lines.join("\n")
    .replace(/(`+)[\s\S]*?\1/g, " ")
    .replace(/"(?:\\.|[^"\\])*"/g, " ")
    .replace(/“[^”]*”|‘[^’]*’/g, " ")
    .replace(/(^|[\s([{])'(?:\\.|[^'\\])*'/g, "$1 ");
}

function optedOut(text: string): boolean {
  return /\b(?:no|without)\s+(?:any\s+)?(?:workflows?|ultracode)\b/i.test(text)
    || /\b(?:do\s+not|don['’]t|never|avoid)\s+(?:(?:use|using|run|running|start|starting|enable|enabling|trigger|triggering|invoke|invoking)\s+)?(?:(?:an?|the|any)\s+)?(?:workflows?|ultracode)\b/i.test(text)
    || /\b(?:disable|turn\s+off)\s+(?:the\s+)?ultracode\b/i.test(text);
}

function discussionOnly(text: string): boolean {
  return /^\s*(?:what|why|where|when|who|how|explain|describe|define|document|summari[sz]e|translate|quote)\b/i.test(text)
    || /\b(?:keyword|word|term|example|mention|named|called|says?|said|spelled)\b[^\n.!?]{0,60}\bultracode\b/i.test(text)
    || /\bultracode\b[^\n.!?]{0,30}\b(?:keyword|word|term|means?|meaning)\b/i.test(text)
    || /\b(?:do\s+not|don['’]t|never|avoid)\b[^\n.!?]{0,60}\bultracode\b/i.test(text);
}

export function ultracodeTrigger(input: {
  parts: UltracodeTriggerPart[];
  parentID?: string;
  role?: string;
  /** Only the integration can establish trusted human input provenance. Missing is not human. */
  human: boolean;
  optOut?: boolean;
  settings: UltracodeSettings;
}): UltracodeTrigger {
  const task = input.parts.filter((part) => part.type === "text" && !part.synthetic && !part.ignored && typeof part.text === "string")
    .map((part) => part.text!).join("\n");
  const inactive: UltracodeTrigger = { active: false, task };
  if (input.parentID || input.role !== "user" || input.optOut || !task.trim()
    || input.parts.some((part) => /^(?:tool|tool[_-]result)$/.test(part.type))) return inactive;
  const text = matchingText(task);
  if (!text.trim() || optedOut(text)) return inactive;
  // Enabled mode asks the model to judge substance; simple questions still get direct answers.
  if (input.settings.enabled) return { active: true, source: "session", task };
  if (!input.human || discussionOnly(text)) return inactive;
  if (input.settings.keyword && /\bultracode\b/i.test(text)) return { active: true, source: "keyword", task };
  if (/\b(?:use|run|start|launch)\s+(?:(?:an?|the)\s+)?workflows?\b/i.test(text)) return { active: true, source: "workflow-request", task };
  return inactive;
}

export function ultracodeInstruction(input: { source: NonNullable<UltracodeTrigger["source"]>; effort?: UltracodeEffort | null }): string {
  return [
    "Ultracode workflow assistance is opted in for this request. This is not a recurring goal or an instruction to expand the user's scope.",
    "Judge the current request semantically: use workflows for substantive implementation, investigation, debugging, refactoring, or verification with useful delegated tasks. Answer greetings, simple factual questions, clarifications, status questions, and trivial edits directly when orchestration adds no value. Do not manufacture a team for every message.",
    "Read workflow_reference before planning. Choose the smallest sufficient team and appropriate models from the configured allowed pool; honor explicit user assignments and all strict model, permission, and approval rules. Explain each assignment briefly and use declarative plans; generated orchestration remains private. Do not write orchestration files, print orchestration source, or load unrelated recurring loop/Ralph skills. Custom scripts are available only when the user asks for them.",
    "For multi-stage work, first investigate or clarify the actual requirements when necessary, then implement, then verify the changed result with current evidence. Adapt stage boundaries to the task; do not mechanically create stages or repeat already completed work.",
    "When a workflow result arrives, inspect its evidence against the original request. Launch another scoped workflow only if a concrete necessary stage or repair remains. Continue until the requested work is actually verified, or report a genuine blocker or required user choice. A workflow finishing is not by itself proof that the user's task is complete. Never automatically relaunch user-stopped work or skipped assignments.",
    "While a workflow is live, use its status and final notification rather than duplicate work or repeatedly poll. Do not schedule recurring idle prompts, create an unbounded goal loop, treat a transient observation timeout as failed work, or keep spawning tasks after completion. User interruption, opt-out, changed scope, and required approvals remain authoritative.",
    input.source === "session"
      ? input.effort
        ? `The selected session reasoning preference is ${input.effort}. Apply only a genuinely supported exact ${input.effort} variant; never rename max, thinking, or another variant to ${input.effort}. Unsupported models retain their supported/default behavior and must not be described as using ${input.effort}.`
        : "Automatic workflows are enabled for this session with its current effort. Preserve the user's current model and variant unless they explicitly request a change."
      : "This one-shot request does not change session reasoning effort, persistent defaults, or session mode. Preserve the user's current model and variant unless they explicitly request a change.",
  ].join("\n");
}
