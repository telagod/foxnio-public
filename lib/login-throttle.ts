/**
 * Brake for `POST /api/web-auth/session`. The password is scrypt-hashed, so a
 * guess costs the server real CPU and memory; without a limit one client can
 * both brute-force the password and starve the process.
 *
 * Two independent limits, both held in memory (a restart clears them, which is
 * acceptable for a single-user server):
 *  - per client key: after `maxFailures` consecutive failures the key is locked
 *    for an exponentially growing time (capped), and attempts during the lock
 *    are refused without being verified or extending the lock;
 *  - global: at most `maxInFlight` verifications run at once, so a flood of
 *    distinct keys cannot occupy the thread pool.
 */

export interface LoginThrottleOptions {
  /** Clock in milliseconds; injectable for tests. */
  now?: () => number;
  /** Consecutive failures that trigger the first lock. */
  maxFailures?: number;
  /** Length of the first lock; doubles with every further failure. */
  baseLockMs?: number;
  /** Longest lock. */
  maxLockMs?: number;
  /** A key with no failure for this long starts over from zero failures. */
  forgetAfterMs?: number;
  /** Most keys remembered at once; the least recently active are dropped first. */
  maxKeys?: number;
  /** Most password verifications running at the same time. */
  maxInFlight?: number;
}

export interface LoginAttempt {
  allowed: true;
  /** Release the slot and record the outcome. Call exactly once. */
  finish(success: boolean): void;
}

export interface LoginRefusal {
  allowed: false;
  reason: "locked" | "busy";
  retryAfterSeconds: number;
}

export interface LoginThrottle {
  begin(key: string): LoginAttempt | LoginRefusal;
  /** Number of keys currently remembered. */
  size(): number;
}

interface KeyState {
  failures: number;
  lockedUntil: number;
  lastFailureAt: number;
}

const MAX_KEY_LENGTH = 64;
const DIRECT_CLIENT_KEY = "direct";

/**
 * Identify the client. Behind a reverse proxy the first `X-Forwarded-For` hop
 * (or `X-Real-IP`) is the caller; a direct connection shares one key. These
 * headers are only as trustworthy as the proxy in front of the server, so the
 * global in-flight limit, not this key, is the hard bound on guessing speed.
 */
export function loginThrottleKey(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const candidate = forwarded || headers.get("x-real-ip")?.trim();
  return candidate ? candidate.slice(0, MAX_KEY_LENGTH) : DIRECT_CLIENT_KEY;
}

export function createLoginThrottle(options: LoginThrottleOptions = {}): LoginThrottle {
  const now = options.now ?? Date.now;
  const maxFailures = options.maxFailures ?? 5;
  const baseLockMs = options.baseLockMs ?? 15_000;
  const maxLockMs = options.maxLockMs ?? 5 * 60_000;
  const forgetAfterMs = options.forgetAfterMs ?? 15 * 60_000;
  const maxKeys = options.maxKeys ?? 1000;
  const maxInFlight = options.maxInFlight ?? 2;

  // Map iteration order is insertion order; entries are re-inserted when they
  // change, so the first entry is always the least recently active one.
  const states = new Map<string, KeyState>();
  let inFlight = 0;

  const isExpired = (state: KeyState, at: number) =>
    state.lockedUntil <= at && at - state.lastFailureAt >= forgetAfterMs;

  function prune(at: number): void {
    for (const [key, state] of states) {
      if (isExpired(state, at)) states.delete(key);
    }
    while (states.size >= maxKeys) {
      const oldest = states.keys().next();
      if (oldest.done) break;
      states.delete(oldest.value);
    }
  }

  function recordFailure(key: string): void {
    const at = now();
    const previous = states.get(key);
    const known = previous && !isExpired(previous, at) ? previous : undefined;
    if (!known) prune(at);
    const failures = (known?.failures ?? 0) + 1;
    const lockedUntil = failures >= maxFailures
      ? at + Math.min(maxLockMs, baseLockMs * 2 ** Math.min(failures - maxFailures, 30))
      : 0;
    states.delete(key);
    states.set(key, { failures, lockedUntil, lastFailureAt: at });
  }

  return {
    begin(key) {
      const at = now();
      const state = states.get(key);
      if (state && state.lockedUntil > at) {
        return { allowed: false, reason: "locked", retryAfterSeconds: Math.ceil((state.lockedUntil - at) / 1000) };
      }
      if (inFlight >= maxInFlight) return { allowed: false, reason: "busy", retryAfterSeconds: 1 };

      inFlight += 1;
      let finished = false;
      return {
        allowed: true,
        finish(success) {
          if (finished) return;
          finished = true;
          inFlight -= 1;
          if (success) states.delete(key);
          else recordFailure(key);
        },
      };
    },
    size: () => states.size,
  };
}

/** The throttle shared by the sign-in route. */
export const loginThrottle: LoginThrottle = createLoginThrottle();
