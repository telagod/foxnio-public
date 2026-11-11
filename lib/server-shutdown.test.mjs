import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const moduleUrl = new URL("./server-shutdown.ts", import.meta.url).href;

// Every case owns a real process: an early process.exit must fail the durable
// marker assertion, not merely call a spy. POSIX cases use actual OS signals.
function runChild(body, { keepAlive = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "foxnio-shutdown-"));
  const marker = join(directory, "durable");
  const events = join(directory, "events");
  try {
    const script = `
      import assert from "node:assert/strict";
      import { appendFileSync, readFileSync } from "node:fs";
      import { open } from "node:fs/promises";
      import { setTimeout as sleep } from "node:timers/promises";
      import { installServerShutdownBarrier } from ${JSON.stringify(moduleUrl)};
      const marker = ${JSON.stringify(marker)};
      const record = (value) => appendFileSync(${JSON.stringify(events)}, value + "\\n");
      const originalExit = process.exit;
      const sendSignal = (signal) => {
        if (process.platform === "win32") process.emit(signal, signal);
        else process.kill(process.pid, signal);
      };
      const save = async () => {
        await sleep(60);
        const file = await open(marker, "w");
        try {
          await file.writeFile("durable");
          await file.sync();
        } finally {
          await file.close();
        }
        record("drained");
      };
      ${keepAlive ? "setInterval(() => {}, 1_000);" : ""}
      ${body}
    `;
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: 5_000,
      killSignal: "SIGKILL",
    });
    assert.ifError(child.error);
    assert.equal(child.signal, null, child.stderr);
    return {
      status: child.status,
      stderr: child.stderr,
      marker: existsSync(marker) ? readFileSync(marker, "utf8") : null,
      events: existsSync(events) ? readFileSync(events, "utf8").trim().split("\n") : [],
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const [signal, exitCode] of [["SIGTERM", 143], ["SIGINT", 130]]) {
  test(`${signal}: an existing process.exit listener cannot outrun the durable drain`, () => {
    const result = runChild(`
      process.on(${JSON.stringify(signal)}, function (received) {
        assert.equal(this, process);
        assert.equal(received, ${JSON.stringify(signal)});
        assert.equal(process.exit, originalExit);
        assert.equal(readFileSync(marker, "utf8"), "durable");
        record("original");
        process.exit(${exitCode});
      });
      installServerShutdownBarrier(async () => {
        record("stop");
        await save();
      });
      setTimeout(() => sendSignal(${JSON.stringify(signal)}), 0);
    `);
    assert.equal(result.status, exitCode, result.stderr);
    assert.equal(result.marker, "durable");
    assert.deepEqual(result.events, ["stop", "drained", "original"]);
    assert.doesNotMatch(result.stderr, /shutdown.*failed/i);
  });

  test(`${signal}: no prior handler falls back to its signal exit code after draining`, () => {
    const result = runChild(`
      installServerShutdownBarrier(save);
      process.once(${JSON.stringify(signal)}, () => record("late-rpc-disposal"));
      setTimeout(() => sendSignal(${JSON.stringify(signal)}), 0);
    `);
    assert.equal(result.status, exitCode, result.stderr);
    assert.equal(result.marker, "durable");
    assert.deepEqual(result.events, ["late-rpc-disposal", "drained"]);
  });
}

test("repeated and cross-signals join the first drain instead of invoking another exit handler", () => {
  const result = runChild(`
    process.on("SIGTERM", () => { record("term"); process.exit(143); });
    process.on("SIGINT", () => { record("int"); process.exit(130); });
    installServerShutdownBarrier(async () => {
      record("stop");
      setTimeout(() => sendSignal("SIGTERM"), 5);
      setTimeout(() => sendSignal("SIGINT"), 15);
      setTimeout(() => sendSignal("SIGTERM"), 25);
      await save();
    });
    setTimeout(() => sendSignal("SIGTERM"), 0);
  `);
  assert.equal(result.status, 143, result.stderr);
  assert.equal(result.marker, "durable");
  assert.deepEqual(result.events, ["stop", "drained", "term"]);
});

test("raw listeners retain original order, process context and once-wrapper state", () => {
  const result = runChild(`
    process.on("SIGTERM", function (signal) {
      assert.equal(this, process);
      assert.equal(signal, "SIGTERM");
      record("first");
    });
    process.once("SIGTERM", function (signal) {
      assert.equal(this, process);
      assert.equal(signal, "SIGTERM");
      record("once");
    });
    const onceWrapper = process.rawListeners("SIGTERM")[1];
    process.on("SIGTERM", function () {
      onceWrapper.call(process, "SIGTERM");
      record("last");
      process.exit(143);
    });
    installServerShutdownBarrier(save);
    setTimeout(() => sendSignal("SIGTERM"), 0);
  `);
  assert.equal(result.status, 143, result.stderr);
  assert.deepEqual(result.events, ["drained", "first", "once", "last"]);
});

test("existing and later RPC disposal handlers both run with Next-style asynchronous exit", () => {
  const result = runChild(`
    process.on("SIGTERM", () => setImmediate(() => process.exit(143)));
    process.once("SIGTERM", () => record("existing-rpc-disposal"));
    installServerShutdownBarrier(save);
    process.once("SIGTERM", () => record("late-rpc-disposal"));
    setTimeout(() => sendSignal("SIGTERM"), 0);
  `);
  assert.equal(result.status, 143, result.stderr);
  assert.equal(result.marker, "durable");
  assert.deepEqual(result.events, ["late-rpc-disposal", "drained", "existing-rpc-disposal"]);
});

test("module re-evaluation updates the pending stop callback without installing nested barriers", () => {
  const result = runChild(`
    process.on("SIGTERM", () => { record("original"); process.exit(143); });
    installServerShutdownBarrier(async () => { throw new Error("stale runtime"); }, { timeoutMs: 10 });
    const reloaded = await import(${JSON.stringify(`${moduleUrl}?instrumentation-reload`)});
    reloaded.installServerShutdownBarrier(async () => {
      record("stop");
      installServerShutdownBarrier(async () => { throw new Error("reentrant runtime"); }, { timeoutMs: 1 });
      await save();
    }, { timeoutMs: 1_000 });
    setTimeout(() => sendSignal("SIGTERM"), 0);
  `);
  assert.equal(result.status, 143, result.stderr);
  assert.equal(result.marker, "durable");
  assert.deepEqual(result.events, ["stop", "drained", "original"]);
  assert.doesNotMatch(result.stderr, /shutdown.*failed|stale runtime|reentrant runtime/i);
});

for (const [name, stop] of [
  ["rejection", 'async () => { throw new Error("disk unavailable"); }'],
  ["synchronous throw", '() => { throw new Error("disk unavailable"); }'],
]) {
  test(`shutdown ${name} reports unsaved writes before bounded signal exit`, () => {
    const result = runChild(`
      process.on("SIGTERM", () => process.exit(143));
      installServerShutdownBarrier(${stop}, { timeoutMs: 40 });
      setTimeout(() => sendSignal("SIGTERM"), 0);
    `);
    assert.equal(result.status, 143, result.stderr);
    assert.equal(result.marker, null);
    assert.match(result.stderr, /shutdown.*failed/i);
    assert.match(result.stderr, /unsaved/i);
    assert.match(result.stderr, /disk unavailable/);
  });
}

test("a hung drain reaches its deadline, reports unsaved writes and releases an existing exit handler", () => {
  const result = runChild(`
    process.on("SIGTERM", () => process.exit(143));
    installServerShutdownBarrier(() => Promise.withResolvers().promise, { timeoutMs: 40 });
    setTimeout(() => sendSignal("SIGTERM"), 0);
  `);
  assert.equal(result.status, 143, result.stderr);
  assert.match(result.stderr, /shutdown.*timed out/i);
  assert.match(result.stderr, /unsaved/i);
});

test("a hung production drain warns and exits before the launcher's four-second kill", () => {
  const result = runChild(`
    process.on("SIGTERM", () => process.exit(143));
    installServerShutdownBarrier(() => Promise.withResolvers().promise);
    setTimeout(() => { record("supervisor-forced-exit"); process.exit(137); }, 4_000);
    setTimeout(() => sendSignal("SIGTERM"), 0);
  `);
  assert.equal(result.status, 143, result.stderr);
  assert.match(result.stderr, /unsaved/i);
  assert.equal(result.events.includes("supervisor-forced-exit"), false);
});

test("the drain deadline keeps an otherwise idle process alive until fallback exit", () => {
  const result = runChild(`
    installServerShutdownBarrier(() => Promise.withResolvers().promise, { timeoutMs: 40 });
    process.emit("SIGINT", "SIGINT");
  `, { keepAlive: false });
  assert.equal(result.status, 130, result.stderr);
  assert.match(result.stderr, /timed out/i);
  assert.match(result.stderr, /unsaved/i);
});

test("invalid deadline values cannot disable bounded shutdown", () => {
  const result = runChild(`
    for (const timeoutMs of [NaN, Infinity, 0, -1, 2 ** 31]) {
      assert.throws(() => installServerShutdownBarrier(save, { timeoutMs }), RangeError);
    }
    process.exit(0);
  `);
  assert.equal(result.status, 0, result.stderr);
});
