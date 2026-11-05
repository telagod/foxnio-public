import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { hashPassword, verifyPassword, verifyPasswordAsync } = require("./omp-web-password-hash.js");

// N = 2^12: same code path as production cost, a fraction of the time.
const hash = hashPassword("correct horse", { logN: 12 });

test("verifyPasswordAsync agrees with verifyPassword on valid and invalid passwords", async () => {
  for (const candidate of ["correct horse", "correct horse ", "Correct horse", "", "\u0000", "é".repeat(500)]) {
    assert.equal(await verifyPasswordAsync(candidate, hash), verifyPassword(candidate, hash), JSON.stringify(candidate.slice(0, 20)));
  }
  assert.equal(await verifyPasswordAsync("correct horse", hash), true);
  assert.equal(await verifyPasswordAsync("wrong", hash), false);
});

test("verifyPasswordAsync fails closed on malformed or too-weak hashes", async () => {
  const weak = hashPassword("correct horse", { logN: 4 });
  const [, , r, p, salt, digest] = hash.split("$");
  const cases = [
    undefined,
    null,
    "",
    "correct horse",
    "scrypt$12$8$1$short$short",
    `${hash}x`,
    weak,
    `scrypt$12$8$1$${salt}$${digest.slice(0, -4)}AAAA`,
    // Absurd cost parameters must be refused, not attempted.
    `scrypt$30$${r}$${p}$${salt}$${digest}`,
  ];
  for (const stored of cases) {
    assert.equal(await verifyPasswordAsync("correct horse", stored), verifyPassword("correct horse", stored), String(stored));
    assert.equal(await verifyPasswordAsync("correct horse", stored), false, String(stored));
  }
});

test("verifyPasswordAsync treats a non-string candidate as a failed attempt", async () => {
  assert.equal(await verifyPasswordAsync(undefined, hash), false);
  assert.equal(await verifyPasswordAsync(12345, hash), false);
});

test("verifyPasswordAsync leaves the event loop running while it hashes", async () => {
  const slow = hashPassword("correct horse", { logN: 16 });
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 1);
  try {
    assert.equal(await verifyPasswordAsync("correct horse", slow), true);
  } finally {
    clearInterval(timer);
  }
  assert.ok(ticks > 0, "timers must fire during an async verification");
});
