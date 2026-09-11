import type { ModelSelection } from "../models";
import type { WorkflowPlan } from "../plan";
import type { Usage } from "../run/state";
import type { ExecutionFailure } from "../run/failure";

export type GoalMode = "active" | "paused" | "blocked" | "completed" | "cancelled";
export type GoalStage = "defining" | "reviewing" | "planning" | "executing" | "verifying";
export type GoalSource = { path: string; hash: string; snapshot: string };
export type GoalOperation = {
  id: string; runID: string; generation: number; stage: GoalStage; owner: string;
  fingerprint?: string; startedAt: number;
};
export type GoalEvidence = { criterion: string; met: boolean; method: string; observation: string; artifact: string };
export type GoalState = {
  version: 1; id: string; directory: string; sessionID: string;
  originalObjective: string; objective: string; objectiveRevision: number; generation: number;
  mode: GoalMode; stage: GoalStage; createdAt: number; updatedAt: number;
  agent: string; model: ModelSelection; criteria: string[]; cycle: number;
  summary: string; reason?: string; nextWakeAt: number; failures: number;
  operation?: GoalOperation; plan?: WorkflowPlan; lastRunID?: string;
  lastExecutionRunID?: string;
  lastExecutionResult?: string;
  draftContract?: { criteria: string[]; summary: string };
  rejectedContract?: { criteria: string[]; summary: string };
  contractFeedback?: string[];
  sources?: GoalSource[];
  contractRejections?: number;
  coordinator?: ModelSelection;
  waiting?: { kind: string; since: number; until?: number; failure?: ExecutionFailure;
    permission?: { id: string; name: string; sessionID: string } };
  noticeKey?: string; lastNoticeKey?: string; lastNoticeAt?: number;
  evidence: GoalEvidence[]; verifiedAt?: number; fingerprint?: string; usage: Usage;
  notification?: "pending" | "sending" | "delivered" | "uncertain";
};
export type GoalEvent = { sequence: number; at: number; kind: string; data: unknown };
export const terminalGoal = (goal: GoalState) => goal.mode === "completed" || goal.mode === "cancelled";
export const goalResultKey = "workflowGoalResult";

export function goalSummary(goal: GoalState): string {
  return `${goal.objective}\n${goal.mode}${goal.waiting ? ` (waiting: ${goal.waiting.kind}${goal.waiting.until ? ` until ${new Date(goal.waiting.until).toISOString()}` : ""})` : ""} · ${goal.operation?.stage ?? goal.stage} · ${goal.cycle} workflow attempts\n`
    + `${goal.coordinator ? `Supervisor model: ${goal.coordinator.providerID}/${goal.coordinator.modelID}${goal.coordinator.variant ? ` (${goal.coordinator.variant})` : ""}\n` : ""}`
    + `${goal.evidence.filter(item => item.met).length}/${goal.criteria.length} criteria verified\n`
    + `${goal.summary}${goal.reason ? `\n${goal.reason}` : ""}`;
}
