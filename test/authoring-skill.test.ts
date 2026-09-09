import { afterEach, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authoringSkillContent, ensureAuthoringSkill } from "../src/core/authoring-skill.ts";
import { reference } from "../src/core/reference.ts";

const fixtures: string[] = [];
afterEach(async () => {
  for (const directory of fixtures.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "workflow-authoring-test-"));
  fixtures.push(directory);
  return directory;
}

test("materializes authoring guidance from the runtime contract in a content-addressed cache", async () => {
  const cache = await fixture();
  const root = await ensureAuthoringSkill(cache);
  expect(root).toMatch(/\/opencode\/workflow\/skills\/authoring-v1-[a-f0-9]{64}$/);
  expect(authoringSkillContent).toStartWith("---\nname: workflow-authoring\n");
  expect(authoringSkillContent).toEndWith(reference);
  const file = join(root, "workflow-authoring", "SKILL.md");
  expect(await readFile(file, "utf8")).toBe(authoringSkillContent);
  expect((await lstat(file)).mode & 0o777).toBe(0o600);
});

test("concurrent initialization is atomic, repeatable, and leaves no temporary files", async () => {
  const cache = await fixture();
  const roots = await Promise.all(Array.from({ length: 12 }, () => ensureAuthoringSkill(cache)));
  expect(new Set(roots).size).toBe(1);
  const file = join(roots[0]!, "workflow-authoring", "SKILL.md");
  const before = await lstat(file);
  expect(await ensureAuthoringSkill(cache)).toBe(roots[0]);
  expect((await lstat(file)).mtimeMs).toBe(before.mtimeMs);
  expect(await readFile(file, "utf8")).toBe(authoringSkillContent);
  expect(await readdir(join(roots[0]!, "workflow-authoring"))).toEqual(["SKILL.md"]);
});

test("repairs an incomplete owned cache file without a package build", async () => {
  const cache = await fixture();
  const root = await ensureAuthoringSkill(cache);
  const file = join(root, "workflow-authoring", "SKILL.md");
  await writeFile(file, "incomplete");
  expect(await ensureAuthoringSkill(cache)).toBe(root);
  expect(await readFile(file, "utf8")).toBe(authoringSkillContent);
});

test("refuses a symlinked cache subtree without writing through it", async () => {
  const cache = await fixture();
  const external = await fixture();
  await symlink(external, join(cache, "opencode"));
  await expect(ensureAuthoringSkill(cache)).rejects.toThrow("owned directory");
  expect(await readdir(external)).toEqual([]);
});

test("refuses a symlinked skill file and preserves its target", async () => {
  const cache = await fixture();
  const root = await ensureAuthoringSkill(cache);
  const file = join(root, "workflow-authoring", "SKILL.md");
  const external = join(cache, "outside.txt");
  await writeFile(external, "untouched");
  await rm(file);
  await symlink(external, file);
  await expect(ensureAuthoringSkill(cache)).rejects.toThrow("owned regular file");
  expect(await readFile(external, "utf8")).toBe("untouched");
});

test("rejects a directory where the generated skill file belongs", async () => {
  const cache = await fixture();
  const root = await ensureAuthoringSkill(cache);
  const file = join(root, "workflow-authoring", "SKILL.md");
  await rm(file);
  await mkdir(file);
  await expect(ensureAuthoringSkill(cache)).rejects.toThrow("owned regular file");
});
