import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createLoginThrottle, loginThrottleKey } = await jiti.import("./login-throttle.ts");

function setup(options = {}) {
  const clock = { now: 1_000_000 };
  const throttle = createLoginThrottle({ now: () => clock.now, ...options });
  const fail = (key) => {
    const attempt = throttle.begin(key);
    assert.equal(attempt.allowed, true, `attempt for ${key} must be allowed`);
    attempt.finish(false);
  };
  return { clock, throttle, fail };
}

test("locks a key after five consecutive failures and answers with the remaining time", () => {
  const { clock, throttle, fail } = setup();
  for (let i = 0; i < 4; i += 1) fail("a");
  const fifth = throttle.begin("a");
  assert.equal(fifth.allowed, true, "the fifth attempt is still verified");
  fifth.finish(false);

  const refused = throttle.begin("a");
  assert.equal(refused.allowed, false);
  assert.equal(refused.reason, "locked");
  assert.equal(refused.retryAfterSeconds, 15);

  clock.now += 5_000;
  assert.equal(throttle.begin("a").retryAfterSeconds, 10);
  // Other clients are unaffected.
  const other = throttle.begin("b");
  assert.equal(other.allowed, true);
  other.finish(true);
});

test("lock time doubles with each further failure and is capped", () => {
  const { clock, throttle, fail } = setup({ baseLockMs: 10_000, maxLockMs: 60_000 });
  const lockSeconds = [];
  for (let i = 0; i < 5; i += 1) fail("a");
  for (let round = 0; round < 6; round += 1) {
    const refused = throttle.begin("a");
    assert.equal(refused.allowed, false);
    lockSeconds.push(refused.retryAfterSeconds);
    clock.now += refused.retryAfterSeconds * 1000;
    fail("a");
  }
  assert.deepEqual(lockSeconds, [10, 20, 40, 60, 60, 60]);
});

test("attempts during a lock are refused without extending it", () => {
  const { clock, throttle, fail } = setup();
  for (let i = 0; i < 5; i += 1) fail("a");
  for (let i = 0; i < 10; i += 1) {
    clock.now += 1000;
    assert.equal(throttle.begin("a").allowed, false);
  }
  clock.now += 5_000;
  // 15 s lock, 15 s elapsed: usable again, and a success clears the key.
  const attempt = throttle.begin("a");
  assert.equal(attempt.allowed, true);
  attempt.finish(true);
  for (let i = 0; i < 4; i += 1) fail("a");
  assert.equal(throttle.begin("a").allowed, true, "failure count restarted from zero");
});

test("a success clears earlier failures", () => {
  const { throttle, fail } = setup();
  for (let i = 0; i < 4; i += 1) fail("a");
  const attempt = throttle.begin("a");
  attempt.finish(true);
  assert.equal(throttle.size(), 0);
  for (let i = 0; i < 4; i += 1) fail("a");
  const next = throttle.begin("a");
  assert.equal(next.allowed, true);
  next.finish(false);
  assert.equal(throttle.begin("a").allowed, false);
});

test("failures are forgotten after a quiet period", () => {
  const { clock, throttle, fail } = setup({ forgetAfterMs: 60_000 });
  for (let i = 0; i < 4; i += 1) fail("a");
  clock.now += 60_000;
  fail("a");
  assert.equal(throttle.begin("a").allowed, true, "one failure after the quiet period is not a fifth");
});

test("at most maxInFlight verifications run at once, and finishing frees a slot", () => {
  const { throttle } = setup({ maxInFlight: 2 });
  const first = throttle.begin("a");
  const second = throttle.begin("b");
  assert.equal(first.allowed && second.allowed, true);
  const third = throttle.begin("c");
  assert.equal(third.allowed, false);
  assert.equal(third.reason, "busy");
  assert.ok(third.retryAfterSeconds >= 1);
  // A refused attempt counts as nothing against the key.
  assert.equal(throttle.size(), 0);

  first.finish(true);
  first.finish(true);
  const fourth = throttle.begin("c");
  assert.equal(fourth.allowed, true, "double finish must not free more than one slot");
  assert.equal(throttle.begin("d").allowed, false);
  second.finish(true);
  fourth.finish(true);
  assert.equal(throttle.begin("d").allowed, true);
});

test("the key map stays bounded, dropping the least recently active keys", () => {
  const { clock, throttle, fail } = setup({ maxKeys: 50 });
  for (let i = 0; i < 500; i += 1) {
    fail(`client-${i}`);
    clock.now += 1;
  }
  assert.ok(throttle.size() <= 50, `size ${throttle.size()}`);
  // The newest keys survive, so their failures still count.
  for (let i = 0; i < 4; i += 1) fail("client-499");
  assert.equal(throttle.begin("client-499").allowed, false);
});

test("expired keys are pruned before live ones are evicted", () => {
  const { clock, throttle, fail } = setup({ maxKeys: 10, forgetAfterMs: 1000 });
  for (let i = 0; i < 4; i += 1) fail("keeper");
  for (let i = 0; i < 8; i += 1) fail(`old-${i}`);
  clock.now += 500;
  fail("keeper");
  clock.now += 600;
  // old-* are now past forgetAfterMs; the next new key prunes them.
  for (let i = 0; i < 5; i += 1) fail(`new-${i}`);
  assert.ok(throttle.size() <= 10);
  assert.equal(throttle.begin("keeper").allowed, false, "a locked key survives pruning of idle ones");
});

test("loginThrottleKey uses the first forwarded hop, then X-Real-IP, then one shared key", () => {
  const key = (init) => loginThrottleKey(new Headers(init));
  assert.equal(key({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }), "203.0.113.7");
  assert.equal(key({ "x-forwarded-for": "  203.0.113.7  " }), "203.0.113.7");
  assert.equal(key({ "x-real-ip": "198.51.100.2" }), "198.51.100.2");
  assert.equal(key({ "x-forwarded-for": "", "x-real-ip": "198.51.100.2" }), "198.51.100.2");
  assert.equal(key({ "x-forwarded-for": "203.0.113.7", "x-real-ip": "198.51.100.2" }), "203.0.113.7");
  assert.equal(key({}), key({ "x-forwarded-for": "" }));
  assert.ok(key({ "x-forwarded-for": "x".repeat(5000) }).length <= 64);
});
