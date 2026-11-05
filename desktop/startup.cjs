"use strict";

const http = require("node:http");

const DEFAULT_PORT = 30177;
const PORT_SCAN_LIMIT = 20;
const STARTUP_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 250;

function parsePort(raw) {
  const text = String(raw).trim();
  const port = /^\d{1,5}$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid desktop port: ${raw}`);
  }
  return port;
}

/**
 * Pick the port for the local server. A port set through OMP_WEB_DESKTOP_PORT or
 * PORT is used as given and must be free. Without one the stable default is used
 * (localStorage is per origin, so a stable port keeps UI preferences); when it
 * is taken, for example by a CLI or service instance, the next free port wins.
 */
async function choosePort({ env = process.env, isPortAvailable }) {
  const explicit = env.OMP_WEB_DESKTOP_PORT ?? env.PORT;
  if (explicit !== undefined) {
    const port = parsePort(explicit);
    if (!(await isPortAvailable(port))) {
      throw new Error(`Port ${port} is already in use. Stop the other process or choose another OMP_WEB_DESKTOP_PORT.`);
    }
    return { port, fellBack: false };
  }
  for (let offset = 0; offset < PORT_SCAN_LIMIT; offset += 1) {
    const port = DEFAULT_PORT + offset;
    if (port > 65535) break;
    if (await isPortAvailable(port)) return { port, fellBack: offset > 0 };
  }
  throw new Error(`No free port found between ${DEFAULT_PORT} and ${DEFAULT_PORT + PORT_SCAN_LIMIT - 1}.`);
}

function requestServer(url, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("request timed out")));
    request.once("error", reject);
  });
}

function describeExit(code, signal) {
  return signal ?? `code ${code ?? "unknown"}`;
}

/**
 * Wait until the server answers. Fails at once when the spawned launcher exits or
 * cannot be started, so a launcher that gave up (port in use, bad runtime) is never
 * mistaken for a slow start.
 */
async function waitForServer(url, child, { timeoutMs = STARTUP_TIMEOUT_MS, pollIntervalMs = POLL_INTERVAL_MS, request = requestServer } = {}) {
  let failure = null;
  const onExit = (code, signal) => { failure ??= `foxnio server exited before becoming ready (${describeExit(code, signal)})`; };
  const onError = (error) => { failure ??= `foxnio server could not be started: ${error.message}`; };
  child.once("exit", onExit);
  child.once("error", onError);
  const assertAlive = () => {
    if (failure === null && (child.exitCode != null || child.signalCode != null)) onExit(child.exitCode, child.signalCode);
    if (failure !== null) throw new Error(failure);
  };
  try {
    const deadline = Date.now() + timeoutMs;
    let lastError = "not ready";
    while (Date.now() < deadline) {
      assertAlive();
      let status = null;
      try {
        status = await request(url);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      // An answer that arrives after the launcher died came from some other server.
      assertAlive();
      if (status !== null && status >= 200 && status < 500) return;
      if (status !== null) lastError = `HTTP ${status}`;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    throw new Error(`Timed out waiting for foxnio at ${url}: ${lastError}`);
  } finally {
    child.off("exit", onExit);
    child.off("error", onError);
  }
}

module.exports = { DEFAULT_PORT, PORT_SCAN_LIMIT, choosePort, parsePort, requestServer, waitForServer };
