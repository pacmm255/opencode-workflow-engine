import { homedir } from "node:os";
import { join } from "node:path";
import { failure } from "./errors";

export function runsDirectory(): string {
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode", "workflow", "runs");
}
export function globalConfigDirectory(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode");
}
export function validateRunID(id: string): string {
  if (!/^wf_[a-f0-9-]{36}$/.test(id)) throw failure("RunNotFoundError", "Invalid workflow run ID");
  return id;
}
export function validateName(name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name)) throw failure("WorkflowNameError", "Name must contain 1–80 letters, digits, underscores or hyphens");
  return name;
}
