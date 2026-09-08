export interface RuntimeLimits {
  syncTimeoutMs: number;
  scriptIdleTimeoutMs: number;
  runTimeoutMs: number;
  maxItems: number;
}

export type WorkflowReference = string | { scriptPath: string };

export interface SerializedError { name: string; message: string }

export interface WorkerInput {
  body: string;
  argsJSON: string;
  limits: RuntimeLimits;
  tokenBudget: number | null;
  spent: number;
}

export type WorkerMessage =
  | { type: "ready" }
  | { type: "pong"; timers: number }
  | { type: "call"; id: number; method: "agent" | "workflow"; payload: string }
  | { type: "log" | "phase"; value: string }
  | { type: "done"; value: string }
  | { type: "error"; error: SerializedError };

export type HostMessage =
  | { type: "ping" }
  | { type: "reply"; id: number; value?: string; error?: SerializedError; spent: number };

export function errorData(error: unknown, fallback = "ScriptRuntimeError"): SerializedError {
  const source = error as { name?: unknown; message?: unknown } | undefined;
  return { name: typeof source?.name === "string" ? source.name : fallback, message: typeof source?.message === "string" ? source.message : String(error) };
}

export function runtimeError(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

export function jsonValue(value: unknown, label = "Value"): string {
  try {
    const json = JSON.stringify(value) ?? "null";
    if (json.length > 5_000_000) throw new Error("exceeds 5 MB");
    const pending: Array<[unknown, number]> = [[JSON.parse(json), 0]];
    while (pending.length) {
      const [item, depth] = pending.pop()!;
      if (depth > 64) throw new Error("exceeds 64 nesting levels");
      if (item && typeof item === "object") for (const child of Object.values(item)) pending.push([child, depth + 1]);
    }
    return json;
  } catch (error) {
    throw runtimeError("SerializationError", `${label} must be JSON serializable: ${errorData(error).message}`);
  }
}
