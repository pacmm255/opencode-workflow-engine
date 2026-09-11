import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { GoalSource, GoalState } from "./state";

const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** A referenced implementation plan is an input, not permission to rewrite its requirements. */
export async function captureGoalSources(goal: GoalState, root: string): Promise<GoalSource[]> {
  if (!/\b(?:implement|execute|follow|complete|carry out)\b[\s\S]*\b(?:plan|specification|spec|roadmap)\b/i.test(goal.objective)) return [];
  const sources: GoalSource[] = [];
  const project = await realpath(goal.directory);
  const references = new Set([...goal.objective.matchAll(/(?:^|[\s`"'(\[])([^\s`"'<>]+\.(?:md|txt|rst|adoc))(?=$|[\s`"'),\]])/gi)].map(match => match[1]!));
  for (const reference of references) {
    const path = resolve(project, reference);
    const canonical = await realpath(path).catch(() => undefined);
    if (!canonical) continue;
    const local = relative(project, canonical);
    if (isAbsolute(local) || local === ".." || local.startsWith("../")) throw new Error(`Goal specification is outside the project: ${reference}`);
    const info = await stat(canonical);
    if (!info.isFile() || info.size > 2_000_000) throw new Error(`Goal specification must be a text file of at most 2 MB: ${reference}`);
    const content = await readFile(canonical);
    const hash = digest(content);
    const folder = join(root, "sources", goal.id, String(goal.objectiveRevision));
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const snapshot = join(folder, `${hash}.txt`);
    try { await writeFile(snapshot, content, { flag: "wx", mode: 0o400 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || digest(await readFile(snapshot)) !== hash) throw error;
    }
    sources.push({ path: canonical, hash, snapshot });
  }
  return sources;
}

export async function changedGoalSources(sources: GoalSource[] = []): Promise<string[]> {
  const changed: string[] = [];
  for (const source of sources) {
    const current = await readFile(source.path).catch(() => undefined);
    const snapshot = await readFile(source.snapshot).catch(() => undefined);
    if (!current || !snapshot || digest(current) !== source.hash || digest(snapshot) !== source.hash) changed.push(source.path);
  }
  return changed;
}

/** Catch known phase/scope contamination before asking an independent reviewer to audit meaning. */
export function contractContamination(objective: string, criteria: string[]): string[] {
  if (!/\b(?:implement|build|fix|repair|execute)\b/i.test(objective)) return [];
  const forbidden = /(?:no|without|do not)\s+(?:code|implementation|build(?:s)?|benchmark(?:s)?)(?:\s|,|$)|(?:evidence|acceptance|documentation)[- ]only|scope (?:is|lock[: ]).*?(?:this|plan) (?:file|document) only|(?:limited|restricted) to (?:this|the) (?:plan )?(?:file|document)/i;
  if (forbidden.test(objective)) return []; // An explicit user restriction remains authoritative.
  return criteria.filter(criterion => forbidden.test(criterion)).map(criterion => `Stage-local or invented scope restriction: ${criterion}`);
}
