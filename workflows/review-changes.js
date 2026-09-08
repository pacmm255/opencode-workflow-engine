export const meta = { name: "Review changes", description: "Review changes from complementary perspectives and verify findings" };
const task = args?.task ?? "Review the current uncommitted changes.";
return await pipeline(["correctness", "test coverage", "maintainability"],
  perspective => agent(task + " Focus on " + perspective + ". Return only concrete findings with file locations.", { label: perspective, phase: "Review" }),
  (findings, perspective) => agent("Verify these " + perspective + " findings against the code. Reject unsupported claims: " + findings, { label: perspective, phase: "Verify" })
);
