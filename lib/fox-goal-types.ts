import type { TodoPhase } from "./pi-types";
import type { FoxWorkerReport } from "./fox-report-types";

export interface NativeGoal {
  id: string;
  objective: string;
  status: string;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number | string;
  updatedAt: number | string;
}

export interface NativeGoalModeState {
  enabled: boolean;
  mode: string;
  reason?: string;
  goal: NativeGoal;
}

export interface FoxGoalTerms {
  objective: string;
  projects: string[];
  criteria: Array<{ id: string; text: string }>;
  operations: string[];
  tokenBudget?: number;
  expiresAt?: string;
  maxWorkers: number;
  maxDispatches: number;
  maxRework: number;
}

export interface FoxGoalCoordination {
  grantEntryId: string;
  nativeGoalId: string;
  planItemRef: string;
  purpose: "implementation" | "verification" | "evidence" | "rework";
  criterionIds: string[];
}

export interface FoxGoalGrant {
  id: string;
  goalId: string | null;
  terms: FoxGoalTerms;
  epoch: string;
  createdAt: string;
  revoked: boolean;
  paused: boolean;
  replacesGoalId?: string;
}

export interface FoxGoalAssignment {
  id: string;
  grantEntryId: string;
  goalId: string;
  planItemRef: string;
  purpose: string;
  criterionIds: string[];
  cwd: string;
  workerSessionId: string | null;
  workerFile?: string;
  state: "reserved" | "running" | "settled" | "uncertain" | "closed";
  rework: number;
  fingerprint?: string;
  toolCallId?: string;
  toolName?: string;
}

export interface FoxGoalEvidence {
  kind: "check" | "artifact" | "human";
  reference: string;
  observed: string;
  revision?: string;
}

export interface FoxGoalReview {
  criterionId: string;
  decision: "accept" | "reject";
  reportIds: string[];
  evidence: FoxGoalEvidence[];
}

export interface FoxGoalSnapshot {
  supported: boolean;
  reason?: string;
  goal: NativeGoalModeState | null;
  grant: FoxGoalGrant | null;
  assignments: FoxGoalAssignment[];
  reviews: FoxGoalReview[];
  reports: FoxWorkerReport[];
  dispatchesUsed: number;
  todoPhases: TodoPhase[];
  recovery: "running" | "next" | "waiting" | "paused" | "uncertain";
  updatedAt: string | null;
  /** Establishing native entry for exact phase/content fallback references. */
  planEntryId?: string;
  notifications?: Array<{ key: string; day: string; at: string }>;
  handledReportIds?: string[];
  planReferences?: string[];
  staleReportIds?: string[];
  handoffs?: Array<{ id: string; batchId: string; reportIds: string[]; state: "delivered" | "uncertain" | "not-delivered" }>;
  inheritedGoalIds?: string[];
  resourcePauseReason?: "expired" | "dispatch-limit" | "rework-limit" | "agent-tools-disabled";
}
