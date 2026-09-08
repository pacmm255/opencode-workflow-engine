export const meta = { name: "Code audit", description: "Inspect project reliability and verify proposed improvements" };
return await pipeline(["failure handling", "data persistence", "resource cleanup"],
  area => agent("Inspect " + (args?.target ?? "this project") + " for " + area + ". Read source and report concrete reliability issues.", { phase: "Inspect", label: area }),
  findings => agent("Check these reliability findings against source and existing tests. Return supported issues and suggested fixes: " + findings, { phase: "Verify" })
);
