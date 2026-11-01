import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  NO_ADVISOR_DEFAULT,
  advisorDefaultSource,
  parseAdvisorDefault,
  resolveAdvisorDefault,
  resolveEffectiveAdvisor,
} = await jiti.import("./advisor-default.ts");

test("either the omp config or the workspace launch config enables the default", () => {
  assert.deepEqual(resolveAdvisorDefault({}), NO_ADVISOR_DEFAULT);
  assert.deepEqual(resolveAdvisorDefault({ ompConfig: true }), { enabled: true, ompConfig: true, project: false });
  assert.deepEqual(resolveAdvisorDefault({ project: true }), { enabled: true, ompConfig: false, project: true });
  assert.deepEqual(resolveAdvisorDefault({ ompConfig: true, project: true }), { enabled: true, ompConfig: true, project: true });
});

test("only a literal true counts, so a hand-edited value cannot enable the default", () => {
  for (const value of [false, undefined, null, "true", 1, "yes", {}]) {
    assert.equal(resolveAdvisorDefault({ ompConfig: value, project: value }).enabled, false);
  }
});

test("a malformed default payload means no default", () => {
  for (const data of [null, undefined, "x", 3, [], {}, { ompConfig: "true" }]) {
    assert.deepEqual(parseAdvisorDefault(data), NO_ADVISOR_DEFAULT);
  }
  assert.deepEqual(parseAdvisorDefault({ enabled: true, ompConfig: true, project: false }), { enabled: true, ompConfig: true, project: false });
  // `enabled` is derived from the sources, never trusted from the payload.
  assert.equal(parseAdvisorDefault({ enabled: true }).enabled, false);
});

test("an explicit chat choice overrides the default in either direction", () => {
  const off = resolveAdvisorDefault({});
  const on = resolveAdvisorDefault({ ompConfig: true });
  assert.equal(resolveEffectiveAdvisor(off, "inherit"), false);
  assert.equal(resolveEffectiveAdvisor(off, "on"), true);
  assert.equal(resolveEffectiveAdvisor(off, "off"), false);
  assert.equal(resolveEffectiveAdvisor(on, "inherit"), true);
  assert.equal(resolveEffectiveAdvisor(on, "on"), true);
  assert.equal(resolveEffectiveAdvisor(on, "off"), false);
});

test("the lock reason names the omp config first, then the project", () => {
  assert.equal(advisorDefaultSource(NO_ADVISOR_DEFAULT), null);
  assert.equal(advisorDefaultSource(resolveAdvisorDefault({ ompConfig: true })), "omp-config");
  assert.equal(advisorDefaultSource(resolveAdvisorDefault({ project: true })), "project");
  assert.equal(advisorDefaultSource(resolveAdvisorDefault({ ompConfig: true, project: true })), "omp-config");
});
