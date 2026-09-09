import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink, readdir } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";

/** Hash tracked and nonignored inputs, including dirty/untracked files; never just HEAD. */
export async function workspaceFingerprint(directory: string): Promise<string> {
  const signal = AbortSignal.timeout(30_000);
  const child = Bun.spawn(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: directory, stdout: "pipe", stderr: "ignore", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  const abort = () => child.kill();
  signal.addEventListener("abort", abort, { once: true });
  let files: string[];
  try {
    const output = await new Response(child.stdout).text();
    if (await child.exited === 0) files = [...new Set(output.split("\0").filter(Boolean))];
    else {
      files = [];
      const walk = async (folder: string) => {
        for (const entry of await readdir(folder, { withFileTypes: true })) {
          signal.throwIfAborted();
          if ([".git", "node_modules", ".opencode", ".codex", ".claude"].includes(entry.name)) continue;
          const path = join(folder, entry.name);
          if (entry.isDirectory()) await walk(path);
          else files.push(relative(directory, path));
        }
      };
      await walk(directory);
    }
    const hash = createHash("sha256");
    for (const file of files.sort()) {
      signal.throwIfAborted();
      if (isAbsolute(file) || file.split(/[\\/]/).includes("..")) throw new Error("Invalid workspace input path");
      hash.update(JSON.stringify(file));
      const path = join(directory, file);
      const stat = await lstat(path).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
      if (!stat) { hash.update("missing"); continue; }
      hash.update(String(stat.mode));
      if (stat.isSymbolicLink()) hash.update(await readlink(path));
      else if (stat.isFile()) for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
      else hash.update("directory"); // Submodules/external data require explicit evidence from the verifier.
    }
    return hash.digest("hex");
  } finally { signal.removeEventListener("abort", abort); }
}
