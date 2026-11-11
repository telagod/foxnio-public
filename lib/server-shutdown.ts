import { writeSync } from "node:fs";

type ShutdownState = {
  stop: () => Promise<void>;
  timeoutMs: number;
  started: boolean;
};

const stateKey = Symbol.for("foxnio.serverShutdownBarrier");
const sharedProcess = process as NodeJS.Process & { [stateKey]?: ShutdownState };

/**
 * Next installs its exit handlers before instrumentation.register(). Replace
 * those handlers, rather than adding a competing asynchronous signal listener.
 * Call again on instrumentation reload to update the not-yet-started drain.
 */
export function installServerShutdownBarrier(
  stop: () => Promise<void>,
  // The shortest shipped launcher SIGKILL grace is 4s; leave 1s for its cleanup.
  { timeoutMs = 3_000 }: { timeoutMs?: number } = {},
): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError("Shutdown timeoutMs must be a positive 32-bit timer delay");
  }

  const installed = sharedProcess[stateKey];
  if (installed) {
    if (!installed.started) {
      installed.stop = stop;
      installed.timeoutMs = timeoutMs;
    }
    return;
  }

  const state: ShutdownState = { stop, timeoutMs, started: false };
  sharedProcess[stateKey] = state;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    // Keep the raw once wrappers: invoking .listener would lose their fired
    // state. Calling each raw listener with process also preserves its context.
    const listeners = process.rawListeners(signal);
    for (const listener of listeners) process.removeListener(signal, listener);
    process.on(signal, () => {
      // Both signals share this latch. Never remove these guards after the
      // first signal: a second signal must not restore the default hard exit.
      if (state.started) return;
      state.started = true;
      void drain(state).then(() => {
        if (listeners.length === 0) process.exit(signal === "SIGTERM" ? 143 : 130);
        for (const listener of listeners) listener.call(process, signal);
      });
    });
  }
  // Later listeners (notably lazy RPC disposal hooks) remain ordinary process
  // listeners. They are neither removed nor replayed by the barrier.
}

async function drain(state: ShutdownState): Promise<void> {
  const timeout = Promise.withResolvers<never>();
  // Keep this timer referenced: a pending Promise alone cannot keep Node
  // alive long enough to finish the drain or report a missed deadline.
  const deadline = setTimeout(() => {
    timeout.reject(new Error(`shutdown drain timed out after ${state.timeoutMs}ms`));
  }, state.timeoutMs);
  try {
    await Promise.race([
      Promise.resolve().then(() => state.stop()),
      timeout.promise,
    ]);
  } catch (error) {
    const reason = error instanceof Error ? error.stack ?? error.message : String(error);
    // The next listener may synchronously process.exit(). Flush diagnostics
    // directly to stderr so its buffered stream cannot lose the unsaved warning.
    try {
      writeSync(2, `[omp-web] storage shutdown failed; pending durable writes may be unsaved: ${reason}\n`);
    } catch {
      // A closed stderr must not prevent the original shutdown handlers running.
    }
  } finally {
    clearTimeout(deadline);
  }
}
