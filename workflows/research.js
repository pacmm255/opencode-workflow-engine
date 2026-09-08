export const meta = { name: "Research", description: "Research a question and independently check the evidence" };
const findings = await agent("Research with primary sources and cite links: " + args.question, { phase: "Research" });
if (findings === null) return null;
return await agent("Verify the evidence, flag uncertainty, and synthesize an answer to " + args.question + ": " + findings, { phase: "Verify" });
