import type { ModelSelection } from "../models";
import type { PreparedWorkflowPlan } from "../plan";
import type { UltracodeRequest } from "../ultracode";
import type { GoalOperation } from "../goal/state";

export type Usage = { input: number; output: number; reasoning: number; cost: number };
export const emptyUsage = (): Usage => ({ input: 0, output: 0, reasoning: 0, cost: 0 });
export type AgentState = {
  id: string; sequence: number; label: string; phase?: string; model: string;
  status: "queued" | "running" | "completed" | "failed" | "skipped" | "cached";
  sessionID?: string; directory?: string; usage: Usage; error?: string; attempts?: number;
  taskId?: string; selectionReason?: string; agentType?: string;
};
export type RunState = {
  id: string; name: string; status: "running" | "completed" | "failed" | "aborted" | "timeout" | "interrupted";
  sessionID: string; directory: string; runDir: string; scriptPath: string;
  startedAt: number; finishedAt?: number; ownerPID: number;
  background: boolean; phase?: string; phases: string[]; agents: AgentState[]; usage: Usage;
  logs: string[]; warnings: string[]; error?: string; result?: unknown; resumeFromRunId?: string;
  launchAgent: string; launchModel: ModelSelection; notification?: "pending" | "delivered" | "failed";
  plan?: PreparedWorkflowPlan;
  ultracode?: UltracodeRequest;
  goal?: { id: string; objectiveRevision: number; operation: GoalOperation };
};
