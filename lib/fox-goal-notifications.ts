import type { FoxGoalSnapshot } from "./fox-goal-types";
import type { FoxServiceConfig } from "./fox-service-config";
import { readFoxServiceConfig } from "./fox-service-config";
import { isQuietAt, localDayKey } from "./fox-service-core";
import { publishFoxGoalNotice } from "./notification-hub";
import { readFoxSessionId } from "./fox-session";

export interface FoxGoalNotice {
  key: string;
  day: string;
  kind: "completed" | "input" | "error";
  title: string;
  detail: string;
}

export function nextFoxGoalNotice(snapshot: FoxGoalSnapshot, config: FoxServiceConfig, now = Date.now()): FoxGoalNotice | null {
  if (!snapshot.supported || !snapshot.grant || snapshot.grant.revoked) return null;
  if (isQuietAt(now, config.quietStart, config.quietEnd)) return null;
  const day = localDayKey(now);
  const receipts = snapshot.notifications ?? [];
  if (receipts.filter((entry) => entry.day === day).length >= config.maxDailyGoalNotifications) return null;
  const goalId = snapshot.grant.goalId;
  if (!goalId) return null;
  const title = snapshot.grant.terms.objective;
  const candidates: Array<Omit<FoxGoalNotice, "day" | "title">> = [];
  if (snapshot.goal?.goal.id === goalId && snapshot.goal.goal.status === "complete") {
    candidates.push({ key: `${goalId}:completed`, kind: "completed", detail: title });
  } else {
    const latest = new Map<string, FoxGoalSnapshot["reports"][number]>();
    for (const report of snapshot.reports) {
      const previous = latest.get(report.sourceSessionId);
      if (!previous || report.sequence > previous.sequence) latest.set(report.sourceSessionId, report);
    }
    for (const report of latest.values()) {
      if (report.status === "needs_input" && report.audience !== "coordinator") {
        candidates.push({ key: `${goalId}:decision:${report.id}`, kind: "input", detail: report.summary });
      }
    }
    for (const assignment of snapshot.assignments) {
      if (assignment.state === "uncertain") candidates.push({
        key: `${goalId}:uncertain:${assignment.id}`, kind: "error", detail: assignment.planItemRef,
      });
    }
  }
  const next = candidates.find((candidate) => !receipts.some((receipt) => receipt.key === candidate.key));
  return next ? { ...next, day, title } : null;
}

const pending = new Set<string>();

/** Native receipt records presentation delivery, never acceptance or task progress. */
export async function reconcileFoxGoalNotifications(
  snapshot: FoxGoalSnapshot,
  persist: (record: { key: string; day: string; at: string }) => Promise<void>,
): Promise<void> {
  const notice = nextFoxGoalNotice(snapshot, readFoxServiceConfig());
  const sessionId = await readFoxSessionId();
  if (!notice || !sessionId || pending.has(notice.key)) return;
  pending.add(notice.key);
  try {
    // No attached surface means no delivered notification. Leave the native
    // obligation untouched so a later connection can receive it.
    if (!publishFoxGoalNotice(sessionId, notice)) return;
    await persist({ key: notice.key, day: notice.day, at: new Date().toISOString() });
  } finally {
    pending.delete(notice.key);
  }
}
