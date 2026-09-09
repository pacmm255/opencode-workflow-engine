import type { RunState } from "./state";

const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
export function report(run: RunState): string {
  const counts = (status: string) => run.agents.filter((agent) => agent.status === status).length;
  const result = JSON.stringify(run.result ?? null, null, 2);
  const resume = `workflow(${JSON.stringify({ ...(run.plan ? {} : { scriptPath: run.scriptPath }), resumeFromRunId: run.id })})`;
  const failureRows = run.agents.filter((agent) => agent.error).map((agent) => `${agent.id} ${agent.label}: ${agent.error}`);
  if (run.error) failureRows.unshift(run.error);
  return [
    `Dynamic workflow "${run.name}" ${run.status} in ${Math.round(((run.finishedAt ?? Date.now()) - run.startedAt) / 1000)}s · ${run.agents.length} agents (${counts("completed")} ok, ${counts("cached")} cached, ${counts("failed")} failed, ${counts("skipped")} skipped) · ${run.usage.output + run.usage.reasoning} output tokens (including reasoning) · $${run.usage.cost.toFixed(4)}`,
    `Run ID: ${run.id}`,
    `<result>${escape(result.slice(0, 8000))}${result.length > 8000 ? "\n… full result in result.json" : ""}</result>`,
    `<logs>${escape(run.logs.slice(-30).join("\n"))}</logs>`,
    `<failures>${escape(failureRows.join("\n"))}</failures>`,
    `<agents>\n${run.agents.map((agent) => escape(`${agent.id} | ${agent.phase ?? ""} | ${agent.label} | ${agent.model} | ${agent.status} | ${agent.usage.output} output | ${agent.sessionID ?? ""}${agent.directory && agent.directory !== run.directory ? ` | worktree: ${agent.directory}` : ""}`)).join("\n")}\n</agents>`,
    `<diagnostics>Run dir: ${escape(run.runDir)}\nScript: ${escape(run.scriptPath)}\nJournal: ${escape(run.runDir)}/journal.jsonl\nResume: ${escape(resume)}\n${escape(run.warnings.join("\n"))}</diagnostics>`,
    ...(run.status === "completed" ? [] : [`<recovery>Successful results are reusable. Fix the cause, then ${escape(resume)}</recovery>`]),
  ].join("\n\n");
}
