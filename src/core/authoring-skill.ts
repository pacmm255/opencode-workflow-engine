import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { reference } from "./reference";

/** Generated from the runtime contract, never from local development notes. */
export const authoringSkillContent = `---
name: workflow-authoring
description: Plan a focused team from configured models and run workflows with live progress, dependencies, and resumable execution in OpenCode.
---

# Workflow authoring

Read workflow_reference before choosing the team to obtain the current model catalog and configured subagent roles. Normal tasks use a declarative plan; the engine creates orchestration privately. Do not write temporary workflow scripts or load unrelated loop/scheduling skills.

${reference}`;

const contentHash = createHash("sha256").update(authoringSkillContent).digest("hex");

async function ownedDirectory(directory: string): Promise<void> {
  await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const info = await lstat(directory);
  if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid())) {
    throw new Error(`Workflow authoring cache must be an owned directory: ${directory}`);
  }
}

/** Source installs need no build step or write access to their installed package. */
export async function ensureAuthoringSkill(cacheHome = process.env.XDG_CACHE_HOME): Promise<string> {
  // XDG requires absolute paths. Ignore an invalid relative override instead of
  // creating generated files in whichever project happened to launch OpenCode.
  const cache = cacheHome && isAbsolute(cacheHome) ? cacheHome : join(homedir(), ".cache");
  await mkdir(cache, { recursive: true, mode: 0o700 });
  let directory = await realpath(cache);
  for (const part of ["opencode", "workflow", "skills", `authoring-v1-${contentHash}`]) {
    directory = join(directory, part);
    await ownedDirectory(directory);
  }
  const root = directory;
  const skillDirectory = join(root, "workflow-authoring");
  await ownedDirectory(skillDirectory);
  const file = join(skillDirectory, "SKILL.md");
  const current = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (current) {
    if (!current.isFile() || (process.getuid && current.uid !== process.getuid())) {
      throw new Error(`Workflow authoring cache must contain an owned regular file: ${file}`);
    }
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if ((await handle.stat()).size === Buffer.byteLength(authoringSkillContent)
        && await handle.readFile("utf8") === authoringSkillContent) return root;
    } finally { await handle.close(); }
  }

  const temporary = join(skillDirectory, `.SKILL-${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { await handle.writeFile(authoringSkillContent); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  return root;
}
