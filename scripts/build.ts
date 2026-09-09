import { mkdir, writeFile } from "node:fs/promises";
import { authoringSkillContent } from "../src/core/authoring-skill";

await mkdir("dist", { recursive: true });
const result = await Bun.build({
  entrypoints: ["src/server.ts", "src/tui.ts", "src/core/runtime/worker.ts"],
  outdir: "dist", naming: "[name].js", target: "bun", format: "esm", sourcemap: "external",
  external: ["@opencode-ai/plugin", "@opencode-ai/plugin/tui", "@opencode-ai/sdk/v2", "zod", "ajv", "ajv/dist/2020", "ajv-formats"],
});
if (!result.success) { for (const log of result.logs) console.error(log); process.exit(1); }
await mkdir("dist/skills/workflow-authoring", { recursive: true });
await writeFile("dist/skills/workflow-authoring/SKILL.md", authoringSkillContent);
console.log(`Built ${result.outputs.length} artifacts in dist/`);
