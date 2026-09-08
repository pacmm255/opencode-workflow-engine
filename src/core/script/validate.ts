import vm from "node:vm";
import { parseScript } from "./meta.ts";

/** Compile as plain async JavaScript without executing metadata or the body. */
export function validateScript(source: string): ReturnType<typeof parseScript> {
  const parsed = parseScript(source);
  try {
    new vm.Script(`(async () => {\n"use strict";\n${parsed.body}\n})()`, { filename: "workflow.js" });
  } catch (cause) {
    throw Object.assign(new Error(cause instanceof Error ? cause.message : String(cause)), { name: "ScriptSyntaxError" });
  }
  return parsed;
}
