import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { nextFoxGoalNotice } = await jiti.import("./fox-goal-notifications.ts");
const now = new Date(2026, 10, 11, 12, 0).getTime();
const config = { enabled: false, quietStart: "22:00", quietEnd: "08:00", maxDailyMessages: 1, maxDailyGoalNotifications: 2 };
const snapshot = (extra = {}) => ({
  supported: true, grant: { id: "grant", goalId: "goal", revoked: false, paused: false, terms: { objective: "Ship migration" } },
  goal: { enabled: true, mode: "active", goal: { id: "goal", status: "active", objective: "Ship migration" } },
  reports: [], assignments: [], reviews: [], notifications: [], recovery: "waiting", ...extra,
});
test("routine worker failure is not escalated before FOX has attempted authorized recovery", () => {
  assert.equal(nextFoxGoalNotice(snapshot({ reports: [{ id: "worker:1", sourceSessionId: "worker", sequence: 1, status: "failed", summary: "test failed" }] }), config, now), null);
});
test("goal delivery notification is independent of observation enablement and is durably deduplicated", () => {
  const done = snapshot({ goal: { enabled: false, mode: "exiting", goal: { id: "goal", status: "complete", objective: "Ship migration" } } });
  const notice = nextFoxGoalNotice(done, config, now);
  assert.equal(notice.kind, "completed");
  assert.equal(nextFoxGoalNotice({ ...done, notifications: [{ key: notice.key, day: notice.day, at: new Date(now).toISOString() }] }, config, now), null);
});
test("quiet hours defer a human decision without converting it to handled state", () => {
  const input = snapshot({ reports: [{ id: "worker:2", sourceSessionId: "worker", sequence: 2, status: "needs_input", audience: "human", summary: "Choose deployment target" }] });
  const quiet = new Date(2026, 10, 11, 23, 0).getTime();
  assert.equal(nextFoxGoalNotice(input, config, quiet), null);
  assert.equal(nextFoxGoalNotice(input, config, now).kind, "input");
  const answered = { ...input, reports: [...input.reports, { id: "worker:3", sourceSessionId: "worker", sequence: 3, status: "result", summary: "Answered" }] };
  assert.equal(nextFoxGoalNotice(answered, config, now), null);
});
test("coordinator questions never interrupt the human and daily notification cap does not mutate execution state", () => {
  const input = snapshot({ reports: [{ id: "worker:2", sourceSessionId: "worker", sequence: 2, status: "needs_input", audience: "coordinator", summary: "Which test command?" }] });
  assert.equal(nextFoxGoalNotice(input, config, now), null);
  input.reports[0].audience = "human";
  const notice = nextFoxGoalNotice(input, config, now);
  input.notifications = [1, 2].map((n) => ({ key: `old-${n}`, day: notice.day, at: new Date(now).toISOString() }));
  assert.equal(nextFoxGoalNotice(input, config, now), null);
  assert.equal(input.goal.goal.status, "active");
});
