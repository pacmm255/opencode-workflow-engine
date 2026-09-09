import { expect, test } from "bun:test";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import manifest from "../package.json";

test("private native installs expose source entrypoints and package their runtime files", async () => {
  expect(manifest.private).toBe(true);
  expect(manifest).not.toHaveProperty("publishConfig");
  expect(manifest.exports["./server"].import).toBe("./src/server.ts");
  expect(manifest.exports["./tui"].import).toBe("./src/tui.ts");
  expect(manifest.files).toContain("src");
  expect(manifest.files).toContain("workflows");
  // Keep the legacy, bundled installer available without requiring it for native installs.
  expect(manifest.files).toContain("dist");
  for (const entry of Object.values(manifest.exports)) {
    await access(resolve(import.meta.dir, "..", entry.import));
  }
});

test("Git installation requires no dependency-preparation or lifecycle scripts", () => {
  // Pacote prepares Git dependencies when any of these keys exist, even when
  // Arborist ignores install scripts. In particular, a script named build is
  // enough to trigger nested npm installation in the OpenCode executable.
  for (const script of ["build", "prepare", "prepack", "preinstall", "install", "postinstall"]) {
    expect(manifest.scripts).not.toHaveProperty(script);
  }
  expect(manifest).not.toHaveProperty("workspaces");
  expect(manifest.scripts.bundle).toBe("bun run scripts/build.ts");
});
