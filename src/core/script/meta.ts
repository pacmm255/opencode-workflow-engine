export interface ScriptPhase {
  title: string;
  detail?: string;
  model?: string;
}

export interface ScriptMeta {
  name?: string;
  description?: string;
  whenToUse?: string;
  phases?: ScriptPhase[];
  [key: string]: unknown;
}

export class MetaInvalidError extends Error {
  override name = "MetaInvalidError";
}

/** A small literal reader, deliberately independent of a compiler or eval. */
class LiteralReader {
  offset = 0;
  constructor(readonly source: string) {}

  fail(message: string): never {
    throw new MetaInvalidError(`${message} at character ${this.offset + 1}`);
  }

  skip(): void {
    for (;;) {
      while (/\s/.test(this.source[this.offset] ?? "") && this.offset < this.source.length) this.offset++;
      if (this.source.startsWith("//", this.offset)) {
        const end = this.source.indexOf("\n", this.offset + 2);
        this.offset = end < 0 ? this.source.length : end;
      } else if (this.source.startsWith("/*", this.offset)) {
        const end = this.source.indexOf("*/", this.offset + 2);
        if (end < 0) this.fail("Unterminated comment");
        this.offset = end + 2;
      } else return;
    }
  }

  token(value: string): void {
    this.skip();
    if (!this.source.startsWith(value, this.offset)) this.fail(`Expected ${JSON.stringify(value)}`);
    this.offset += value.length;
  }

  identifier(): string {
    this.skip();
    const match = /^[A-Za-z_$][\w$]*/.exec(this.source.slice(this.offset));
    if (!match) this.fail("Expected a literal property name");
    this.offset += match[0].length;
    return match[0];
  }

  string(): string {
    const quote = this.source[this.offset++];
    let result = "";
    while (this.offset < this.source.length) {
      const char = this.source[this.offset++];
      if (char === quote) return result;
      if (char === "\n" || char === "\r") this.fail("Unescaped newline in string");
      if (char !== "\\") { result += char; continue; }
      const escape = this.source[this.offset++];
      const simple: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" };
      if (escape in simple) {
        if (escape === "0" && /\d/.test(this.source[this.offset] ?? "")) this.fail("Legacy octal escapes are not supported");
        result += simple[escape];
      } else if (escape === "x" || escape === "u") {
        if (escape === "u" && this.source[this.offset] === "{") {
          const match = /^\{([0-9a-fA-F]{1,6})\}/.exec(this.source.slice(this.offset));
          if (!match || Number.parseInt(match[1], 16) > 0x10ffff) this.fail("Invalid Unicode escape");
          this.offset += match[0].length;
          result += String.fromCodePoint(Number.parseInt(match[1], 16));
        } else {
          const count = escape === "x" ? 2 : 4;
          const hex = this.source.slice(this.offset, this.offset + count);
          if (hex.length !== count || !/^[0-9a-fA-F]+$/.test(hex)) this.fail("Invalid string escape");
          this.offset += count;
          result += String.fromCharCode(Number.parseInt(hex, 16));
        }
      } else if (escape === "\n") {
        // JavaScript line continuation.
      } else if (escape === "\r") {
        if (this.source[this.offset] === "\n") this.offset++;
      } else if (escape === quote || escape === "\\" || escape === "/") result += escape;
      else this.fail("Unsupported string escape");
    }
    return this.fail("Unterminated string");
  }

  value(depth = 0): unknown {
    if (depth > 64) this.fail("Metadata is nested too deeply");
    this.skip();
    const char = this.source[this.offset];
    if (char === "'" || char === '"') return this.string();
    if (char === "{" || char === "[") {
      const object = char === "{";
      const output: Record<string, unknown> | unknown[] = object ? Object.create(null) : [];
      const end = object ? "}" : "]";
      this.offset++;
      this.skip();
      while (this.source[this.offset] !== end) {
        if (object) {
          const first = this.source[this.offset];
          const key = first === "'" || first === '"' ? this.string() : this.identifier();
          if (Object.hasOwn(output, key)) this.fail(`Duplicate metadata property ${JSON.stringify(key)}`);
          this.token(":");
          (output as Record<string, unknown>)[key] = this.value(depth + 1);
        } else (output as unknown[]).push(this.value(depth + 1));
        this.skip();
        if (this.source[this.offset] === end) break;
        this.token(",");
        this.skip();
      }
      this.token(end);
      return output;
    }
    const literal = /^(true|false|null)(?![\w$])/.exec(this.source.slice(this.offset));
    if (literal) {
      this.offset += literal[0].length;
      return literal[0] === "null" ? null : literal[0] === "true";
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?(?![\w$])/.exec(this.source.slice(this.offset));
    if (number) {
      this.offset += number[0].length;
      const value = Number(number[0]);
      if (!Number.isFinite(value)) this.fail("Metadata numbers must be finite");
      return value;
    }
    return this.fail("Metadata must contain only literal objects, arrays, strings, numbers, booleans, or null");
  }
}

export function parseScript(source: string): { meta: ScriptMeta; body: string } {
  if (typeof source !== "string" || !source.trim()) throw new MetaInvalidError("Workflow script must be a nonempty string");
  if (source.length > 1_000_000) throw new MetaInvalidError("Workflow script exceeds 1 MB");
  const reader = new LiteralReader(source);
  reader.skip();
  if (!/^export\b/.test(source.slice(reader.offset))) return { meta: {}, body: source };
  const start = reader.offset;
  if (reader.identifier() !== "export" || reader.identifier() !== "const" || reader.identifier() !== "meta") {
    throw new MetaInvalidError("The first export must be export const meta = { ... }");
  }
  reader.token("=");
  const value = reader.value();
  if (!value || Array.isArray(value) || typeof value !== "object") throw new MetaInvalidError("meta must be a literal object");
  const meta = value as ScriptMeta;
  for (const key of ["name", "description"] as const) {
    if (typeof meta[key] !== "string" || !meta[key].trim()) throw new MetaInvalidError(`meta.${key} must be a nonempty string`);
  }
  if (meta.whenToUse !== undefined && typeof meta.whenToUse !== "string") throw new MetaInvalidError("meta.whenToUse must be a string");
  if (meta.phases !== undefined) {
    if (!Array.isArray(meta.phases)) throw new MetaInvalidError("meta.phases must be an array");
    for (const phase of meta.phases) {
      if (!phase || typeof phase !== "object" || Array.isArray(phase) || typeof phase.title !== "string" || !phase.title.trim()) {
        throw new MetaInvalidError("Each meta.phases entry must have a nonempty title");
      }
      for (const key of ["detail", "model"] as const) if (phase[key] !== undefined && typeof phase[key] !== "string") throw new MetaInvalidError(`phase.${key} must be a string`);
    }
  }
  const end = reader.offset;
  reader.skip();
  if (source[reader.offset] === ";") reader.offset++;
  else if (!/[\r\n]/.test(source.slice(end, reader.offset)) && reader.offset < source.length) throw new MetaInvalidError("Expected a semicolon or newline after meta");
  // Preserve source line numbers in VM syntax errors.
  return { meta, body: source.slice(0, start) + source.slice(start, reader.offset).replace(/[^\r\n]/g, " ") + source.slice(reader.offset) };
}
