import { createHash } from "node:crypto";
import { createReadStream, type BigIntStats } from "node:fs";
import { lstat, readlink, readdir } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";

const contents = new Map<string, { stamp: string; hash: string }>();
/** Hash bytes, not just Git HEAD. Reuse a content hash only when inode/size/mtime/ctime are unchanged. */
export async function workspaceFingerprint(directory: string, cancellation?: AbortSignal): Promise<string> {
  const failed = new AbortController();
  const signal = AbortSignal.any([failed.signal, AbortSignal.timeout(120_000), ...(cancellation ? [cancellation] : [])]);
  signal.throwIfAborted();
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
    const sorted = files.sort();
    const entries = new Array<string>(sorted.length);
    let cursor = 0;
    const stamp = (info: BigIntStats) => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.mode].join(":");
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (cursor < sorted.length) {
        const index = cursor++;
        const file = sorted[index]!;
        signal.throwIfAborted();
        if (isAbsolute(file) || file.split(/[\\/]/).includes("..")) throw new Error("Invalid workspace input path");
        const path = join(directory, file);
        const info = await lstat(path, { bigint: true }).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
        if (!info) { entries[index] = JSON.stringify([file, "missing"]); continue; }
        let value = "directory";
        if (info.isSymbolicLink()) value = await readlink(path);
        else if (info.isFile()) {
          const before = stamp(info);
          const cached = contents.get(path);
          if (cached?.stamp === before) value = cached.hash;
          else {
            const content = createHash("sha256");
            for await (const chunk of createReadStream(path, { signal })) content.update(chunk);
            if (stamp(await lstat(path, { bigint: true })) !== before) throw new Error(`Workspace input changed while fingerprinting: ${file}`);
            value = content.digest("hex");
            if (contents.size >= 100_000) contents.delete(contents.keys().next().value!);
            contents.set(path, { stamp: before, hash: value });
          }
        }
        entries[index] = JSON.stringify([file, String(info.mode), value]);
      }
    }));
    signal.throwIfAborted();
    const hash = createHash("sha256");
    for (const entry of entries) hash.update(entry);
    return hash.digest("hex");
  } catch (error) { failed.abort(error); throw error; }
  finally { signal.removeEventListener("abort", abort); }
}
