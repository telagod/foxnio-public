import { storageRequest } from "./storage/client";
import { readFoxSessionRecord } from "./fox-session";
import { resolveSessionPath } from "./session-reader";
import { getRpcSession } from "./rpc-manager";
import { projectFoxGoal } from "./omp/fox-goals.mjs";
import type { FoxGoalSnapshot } from "./fox-goal-types";
import type { FoxReportView } from "./fox-report-types";

/** Display only. Control/admission code must keep using strict native reads. */
export async function getFoxGoalDisplay(): Promise<FoxGoalSnapshot> {
  const pointer = await readFoxSessionRecord();
  if (!pointer.sessionId) return projectFoxGoal([]) as FoxGoalSnapshot;
  const live = getRpcSession(pointer.sessionId);
  const filePath = live?.sessionFile || await resolveSessionPath(pointer.sessionId);
  if (!filePath) throw new Error("The FOX display source is unavailable");
  const projected = (await storageRequest({ operation: "views.goal", filePath })).value;
  const after = await readFoxSessionRecord();
  if (after.sessionId !== pointer.sessionId || after.resetAt !== pointer.resetAt) throw new Error("FOX changed conversations while loading its display");
  if (live?.isAlive()) {
    const current = await live.nativeGoal("get");
    // Native live status overlays the persisted display, never enters app.db.
    if (current.state && current.state.goal.id === projected.grant?.goalId) return { ...projected, goal: current.state };
  }
  return projected;
}

export async function getFoxReportDisplay(filePath: string): Promise<FoxReportView> {
  return (await storageRequest({ operation: "views.report", filePath })).value;
}
