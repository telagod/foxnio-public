import type { FoxGoalEvidence } from "./fox-goal-types";

export type FoxReportStatus = "accepted" | "progress" | "blocked" | "needs_input" | "result" | "failed" | "cancelled";

export interface FoxWorkerReport {
  version: 1;
  id: string;
  sourceSessionId: string;
  parentSessionId: string;
  sequence: number;
  cwd: string;
  at: string;
  source: "agent" | "native";
  status: FoxReportStatus;
  summary: string;
  evidence: string[];
  audience?: "coordinator" | "human";
  structuredEvidence?: FoxGoalEvidence[];
  goalId?: string;
  assignmentId?: string;
  assignmentWorkerSessionId?: string;
  criterionIds?: string[];
  question?: { sessionId: string; requestId?: string };
  toolCallId?: string;
  truncated?: boolean;
}

export interface FoxReportView {
  report: FoxWorkerReport | null;
  delivery: "received" | "pending" | "unavailable";
  error?: string;
  sourceSessionIds?: string[];
}
