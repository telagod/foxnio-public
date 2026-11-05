import assert from "node:assert/strict";
import test from "node:test";
import { resolveStoreSession } from "./resolve-session.ts";

function fakeStore({ sessions = [], status = "ready" } = {}) {
  const calls = [];
  return {
    calls,
    async ensureSession(id) {
      calls.push(id);
      return sessions.find((session) => session.id === id) ?? null;
    },
    getSnapshot: () => ({ sessionsStatus: status }),
  };
}

test("returns the session the store knows", async () => {
  const session = { id: "a", cwd: "/work" };
  assert.equal(await resolveStoreSession(fakeStore({ sessions: [session] }), "a"), session);
});

test("returns null for an id missing from a loaded list", async () => {
  assert.equal(await resolveStoreSession(fakeStore({ sessions: [{ id: "a" }] }), "gone"), null);
});

test("reports unavailable when the list could not be loaded", async () => {
  assert.equal(await resolveStoreSession(fakeStore({ status: "error" }), "a"), "unavailable");
});

test("a known session wins over a failed background refresh", async () => {
  const session = { id: "a", cwd: "/work" };
  assert.equal(await resolveStoreSession(fakeStore({ sessions: [session], status: "error" }), "a"), session);
});
