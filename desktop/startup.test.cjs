"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const http = require("node:http");
const test = require("node:test");
const { DEFAULT_PORT, PORT_SCAN_LIMIT, choosePort, parsePort, requestServer, waitForServer } = require("./startup.cjs");

const busy = (...ports) => async (port) => !ports.includes(port);

test("uses the stable default port when it is free", async () => {
  assert.deepEqual(await choosePort({ env: {}, isPortAvailable: busy() }), { port: DEFAULT_PORT, fellBack: false });
});

test("moves to the next free port when the default is taken", async () => {
  const chosen = await choosePort({ env: {}, isPortAvailable: busy(DEFAULT_PORT, DEFAULT_PORT + 1) });
  assert.deepEqual(chosen, { port: DEFAULT_PORT + 2, fellBack: true });
});

test("fails when no port in the scan range is free", async () => {
  const all = Array.from({ length: PORT_SCAN_LIMIT }, (_, index) => DEFAULT_PORT + index);
  await assert.rejects(choosePort({ env: {}, isPortAvailable: busy(...all) }), /No free port/);
});

test("an explicit port is used as given and never replaced by a neighbour", async () => {
  assert.deepEqual(await choosePort({ env: { OMP_WEB_DESKTOP_PORT: "4321" }, isPortAvailable: busy() }), { port: 4321, fellBack: false });
  assert.deepEqual(await choosePort({ env: { PORT: "4322" }, isPortAvailable: busy() }), { port: 4322, fellBack: false });
  await assert.rejects(
    choosePort({ env: { OMP_WEB_DESKTOP_PORT: "4321" }, isPortAvailable: busy(4321) }),
    /Port 4321 is already in use/,
  );
});

test("OMP_WEB_DESKTOP_PORT wins over PORT", async () => {
  const chosen = await choosePort({ env: { OMP_WEB_DESKTOP_PORT: "4321", PORT: "9999" }, isPortAvailable: busy() });
  assert.equal(chosen.port, 4321);
});

test("rejects malformed ports", () => {
  for (const raw of ["", "  ", "0", "65536", "-1", "80abc", "1e3", "1.5", "abc"]) {
    assert.throws(() => parsePort(raw), /Invalid desktop port/, JSON.stringify(raw));
  }
  assert.equal(parsePort("65535"), 65535);
  assert.equal(parsePort(" 8080 "), 8080);
});

function fakeChild() {
  return Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
}

test("waitForServer resolves once the server answers", async () => {
  let calls = 0;
  const request = async () => {
    calls += 1;
    if (calls < 3) throw new Error("ECONNREFUSED");
    return 200;
  };
  await waitForServer("http://127.0.0.1:1", fakeChild(), { request, pollIntervalMs: 1 });
  assert.equal(calls, 3);
});

test("waitForServer fails loudly when the launcher exits, even if another server answers", async () => {
  const child = fakeChild();
  // The launcher gave up ("port in use") while an unrelated server keeps answering 200.
  const request = async () => {
    child.exitCode = 1;
    child.emit("exit", 1, null);
    return 200;
  };
  await assert.rejects(waitForServer("http://127.0.0.1:1", child, { request, pollIntervalMs: 1 }), /exited before becoming ready \(code 1\)/);
});

test("waitForServer reports a launcher killed by a signal", async () => {
  const child = fakeChild();
  child.signalCode = "SIGKILL";
  await assert.rejects(waitForServer("http://127.0.0.1:1", child, { request: async () => 200, pollIntervalMs: 1 }), /exited before becoming ready \(SIGKILL\)/);
});

test("waitForServer reports a launcher that cannot be spawned", async () => {
  const child = fakeChild();
  const request = async () => {
    child.emit("error", new Error("spawn node ENOENT"));
    throw new Error("ECONNREFUSED");
  };
  await assert.rejects(waitForServer("http://127.0.0.1:1", child, { request, pollIntervalMs: 1 }), /could not be started: spawn node ENOENT/);
});

test("waitForServer times out with the last error and leaves no listeners behind", async () => {
  const child = fakeChild();
  await assert.rejects(
    waitForServer("http://127.0.0.1:1", child, { request: async () => 503, timeoutMs: 20, pollIntervalMs: 5 }),
    /Timed out waiting for foxnio at http:\/\/127\.0\.0\.1:1: HTTP 503/,
  );
  assert.equal(child.listenerCount("exit"), 0);
  assert.equal(child.listenerCount("error"), 0);
});

test("requestServer returns the HTTP status of a live server", async (t) => {
  const server = http.createServer((_, response) => response.writeHead(204).end());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  assert.equal(await requestServer(`http://127.0.0.1:${server.address().port}`), 204);
});
