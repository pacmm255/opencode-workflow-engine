import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { failure } from "../errors";

export function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

// Raw semantic options preserve replay across policy and display changes. A run
// is a replay of successful work; it does not promise a fresh filesystem view.
export function cacheKey(prompt: string, options: Record<string, unknown>): string {
  const normalized = Object.fromEntries(["schema", "model", "effort", "isolation", "agentType", "tools", "system", "variant"]
    .filter((key) => options[key] !== undefined).map((key) => [key, options[key]]));
  return createHash("sha256").update(prompt).update("\0").update(canonical(normalized)).digest("hex");
}

export async function atomicJSON(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export type JournalEntry = { type: string; at?: number; [key: string]: unknown };

export class Journal {
  private tail: Promise<void> = Promise.resolve();
  constructor(readonly path: string) {}

  append(entry: JournalEntry): Promise<void> {
    const line = JSON.stringify({ at: Date.now(), ...entry }) + "\n";
    // A failed write poisons the queue: callers must not receive an unjournaled result.
    this.tail = this.tail.then(async () => {
      const handle = await open(this.path, "a", 0o600);
      try { await handle.writeFile(line); await handle.sync(); }
      finally { await handle.close(); }
    });
    return this.tail;
  }

  async read(): Promise<JournalEntry[]> {
    let source: string;
    try { source = await readFile(this.path, "utf8"); }
    catch (error) { throw failure("ResumeJournalError", `Cannot read journal ${this.path}: ${String(error)}`); }
    const lines = source.split("\n");
    const result: JournalEntry[] = [];
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      if (!line.trim()) continue;
      try {
        const entry: unknown = JSON.parse(line);
        if (!entry || typeof entry !== "object" || typeof (entry as JournalEntry).type !== "string") throw new Error("Invalid entry");
        result.push(entry as JournalEntry);
      } catch {
        // Only an unterminated final line may have been torn by a process crash.
        if (index === lines.length - 1 && !source.endsWith("\n")) break;
        throw failure("ResumeJournalError", `Invalid journal entry at line ${index + 1}`);
      }
    }
    return result;
  }
}

export class ResumeCache {
  private values = new Map<string, unknown[]>();
  constructor(entries: JournalEntry[]) {
    const successes = entries.filter((entry) => entry.type === "agent.result" || entry.type === "agent.cached")
      .sort((a, b) => Number(a.sequence ?? 0) - Number(b.sequence ?? 0));
    for (const entry of successes) {
      if (typeof entry.key !== "string" || !("value" in entry)) throw failure("ResumeJournalError", "Malformed successful result");
      const bucket = this.values.get(entry.key) ?? [];
      bucket.push(entry.value);
      this.values.set(entry.key, bucket);
    }
  }
  take(key: string): { hit: false } | { hit: true; value: unknown } {
    const bucket = this.values.get(key);
    return bucket?.length ? { hit: true, value: bucket.shift() } : { hit: false };
  }
}
