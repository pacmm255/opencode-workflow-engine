export const meta = { name: "Implement plan", description: "Implement ordered tasks, then review the result" };
const results = [];
for (const task of args.tasks) {
  const result = await agent("Implement this task, preserve unrelated edits, and run relevant checks: " + task, { phase: "Implement" });
  results.push(result);
  if (result === null) return { results, stopped: "A task failed; review before continuing." };
}
return { results, review: await agent("Review the implemented plan for correctness and regressions. Run relevant checks. Plan: " + JSON.stringify(args.tasks), { phase: "Review" }) };
