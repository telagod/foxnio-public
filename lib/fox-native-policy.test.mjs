import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { initializeFoxNativePolicy, foxDispatchPolicy, readFoxServiceConfig, writeFoxServiceConfig } = await jiti.import("./fox-service-config.ts");

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "fox-native-policy-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, legacy: join(home, "chief.db") };
}

test("native policy defaults to real confirmation without creating a legacy database", (t) => {
  const f = fixture(t);
  const config = initializeFoxNativePolicy(f.home, f.legacy);
  assert.equal(config.nativePolicyVersion, 1);
  assert.equal(foxDispatchPolicy(config, "/project"), "confirm");
  assert.deepEqual(readFoxServiceConfig(f.home), config);
});

test("legacy restrictions are copied once without rewriting or executing legacy records", (t) => {
  const f = fixture(t);
  const database = new DatabaseSync(f.legacy);
  database.exec(`
    CREATE TABLE autonomy (project_ref TEXT PRIMARY KEY, level TEXT);
    INSERT INTO autonomy VALUES ('/observe', 'observe'), ('/suggest', 'suggest'), ('/approve', 'approve'), ('/auto', 'auto');
    CREATE TABLE approvals (id TEXT, state TEXT, action_json TEXT);
    INSERT INTO approvals VALUES ('old-request', 'pending', '{"toolName":"new_session"}');
  `);
  database.close();
  const before = readFileSync(f.legacy);
  const config = initializeFoxNativePolicy(f.home, f.legacy);
  assert.deepEqual(config.dispatchPolicies, { "/observe": "observe", "/suggest": "confirm", "/approve": "confirm", "/auto": "auto" });
  assert.deepEqual(readFileSync(f.legacy), before);
  const second = initializeFoxNativePolicy(f.home, join(f.home, "nonexistent.db"));
  assert.deepEqual(second, config);
});

test("migration preserves check settings and explicit native project policy", (t) => {
  const f = fixture(t);
  writeFoxServiceConfig({
    enabled: true, quietStart: "23:30", quietEnd: "07:00", maxDailyMessages: 4,
    dispatchPolicies: { "/project": "observe" },
  }, f.home);
  const config = initializeFoxNativePolicy(f.home, f.legacy);
  assert.equal(config.enabled, true);
  assert.equal(config.quietStart, "23:30");
  assert.equal(config.maxDailyMessages, 4);
  assert.equal(foxDispatchPolicy(config, "/project"), "observe");
});

test("an unreadable legacy policy fails migration instead of widening permissions", (t) => {
  const f = fixture(t);
  const database = new DatabaseSync(f.legacy);
  database.exec("CREATE TABLE unrelated (id TEXT)");
  database.close();
  assert.throws(() => initializeFoxNativePolicy(f.home, f.legacy), /autonomy/);
  assert.equal(readFoxServiceConfig(f.home).nativePolicyVersion, undefined);
});
