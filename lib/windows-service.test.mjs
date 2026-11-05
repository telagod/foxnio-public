import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  DEFAULT_WEB_SERVICE_CONFIG,
  sanitizePort,
  sanitizeHostname,
  sanitizeMode,
  saveWebServiceConfig,
  loadWebServiceConfig,
  getWebServiceConfigPath,
  getWebServiceLogPath,
  getWindowsShortcutPaths,
  getWebServiceStatus,
  getAppVersion,
  getRepoRoot,
  getSystemRoot,
  resolvePowerShellBin,
  resolveWscriptBin,
  resolveTaskkillBin,
  getWindowsExecutionEnv,
  isTrayProcessRunning,
  invalidateTrayRunningCache,
} = await jiti.import("./windows-service.ts");

test("DEFAULT_WEB_SERVICE_CONFIG has correct production ports and settings", () => {
  assert.equal(DEFAULT_WEB_SERVICE_CONFIG.port, 30177);
  assert.equal(DEFAULT_WEB_SERVICE_CONFIG.hostname, "127.0.0.1");
  assert.equal(DEFAULT_WEB_SERVICE_CONFIG.mode, "start");
  assert.equal(DEFAULT_WEB_SERVICE_CONFIG.autostart, true);
  assert.equal(DEFAULT_WEB_SERVICE_CONFIG.openBrowserOnLaunch, false);
  assert.equal(DEFAULT_WEB_SERVICE_CONFIG.autoRestart, true);
});

test("sanitizePort validates numeric and string port values", () => {
  assert.equal(sanitizePort(30177), 30177);
  assert.equal(sanitizePort("30178"), 30178);
  assert.equal(sanitizePort(80), 80);
  assert.equal(sanitizePort(65535), 65535);

  // Invalid values fallback to default or provided fallback
  assert.equal(sanitizePort(0), 30177);
  assert.equal(sanitizePort(-1), 30177);
  assert.equal(sanitizePort(70000), 30177);
  assert.equal(sanitizePort("invalid"), 30177);
  assert.equal(sanitizePort(null, 8080), 8080);
  assert.equal(sanitizePort(undefined, 8080), 8080);
});

test("sanitizePort rejects strings that only start with a number", () => {
  assert.equal(sanitizePort("80abc"), 30177);
  assert.equal(sanitizePort("80 & calc"), 30177);
  assert.equal(sanitizePort("8e3"), 30177);
  assert.equal(sanitizePort("1.5"), 30177);
  assert.equal(sanitizePort(1.5), 30177);
  assert.equal(sanitizePort("0"), 30177);
  assert.equal(sanitizePort("65536"), 30177);
});

test("sanitizeHostname validates and trims hostname strings", () => {
  assert.equal(sanitizeHostname("127.0.0.1"), "127.0.0.1");
  assert.equal(sanitizeHostname("  0.0.0.0  "), "0.0.0.0");
  assert.equal(sanitizeHostname("localhost"), "localhost");
  assert.equal(sanitizeHostname("192.168.1.100"), "192.168.1.100");

  // Invalid values fallback
  assert.equal(sanitizeHostname(""), "127.0.0.1");
  assert.equal(sanitizeHostname("   "), "127.0.0.1");
  assert.equal(sanitizeHostname(null, "fallback.host"), "fallback.host");
  assert.equal(sanitizeHostname(undefined, "fallback.host"), "fallback.host");
});

test("sanitizeHostname accepts IPv6 literals and rejects anything cmd.exe would interpret", () => {
  assert.equal(sanitizeHostname("::"), "::");
  assert.equal(sanitizeHostname("[::1]"), "[::1]");
  assert.equal(sanitizeHostname("my-host.example.com"), "my-host.example.com");
  for (const hostname of [
    "127.0.0.1 & calc &",
    "127.0.0.1&calc",
    "a|b",
    "a;b",
    "a b",
    "a\"b",
    "a^b",
    "%PATH%",
    "$(id)",
    "a`b",
    "a<b",
    "a>b",
    "a\nb",
  ]) {
    assert.equal(sanitizeHostname(hostname), "127.0.0.1", JSON.stringify(hostname));
  }
});

test("saveWebServiceConfig stores valid settings and refuses injected ones without writing", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "web-service-test-"));
  const original = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = original;
    rmSync(dir, { recursive: true, force: true });
  });

  await assert.rejects(saveWebServiceConfig({ hostname: "127.0.0.1 & calc &" }), /Invalid hostname/);
  await assert.rejects(saveWebServiceConfig({ port: "80; calc" }), /Invalid port/);
  await assert.rejects(saveWebServiceConfig({ port: 70000 }), /Invalid port/);
  await assert.rejects(saveWebServiceConfig({ mode: "dev & calc" }), /Invalid mode/);
  assert.equal(existsSync(path.join(dir, "web-service.json")), false);

  const saved = await saveWebServiceConfig({ hostname: " 0.0.0.0 ", port: "8080", mode: "dev" });
  assert.equal(saved.hostname, "0.0.0.0");
  assert.equal(saved.port, 8080);
  assert.equal(saved.mode, "dev");
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "web-service.json"), "utf8")), saved);
});

test("loadWebServiceConfig does not trust a hostname or port edited into the config file", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "web-service-test-"));
  const original = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = original;
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(path.join(dir, "web-service.json"), JSON.stringify({ hostname: "127.0.0.1 & calc &", port: "80 & calc", mode: "start & calc" }));
  const config = await loadWebServiceConfig();
  assert.equal(config.hostname, "127.0.0.1");
  assert.equal(config.port, 30177);
  assert.equal(config.mode, "start");
});

test("sanitizeMode restricts mode to 'start' or 'dev'", () => {
  assert.equal(sanitizeMode("start"), "start");
  assert.equal(sanitizeMode("dev"), "dev");
  assert.equal(sanitizeMode("other"), "start");
  assert.equal(sanitizeMode(null, "dev"), "dev");
  assert.equal(sanitizeMode(undefined), "start");
});

test("getWebServiceConfigPath returns expected web-service.json path", () => {
  const configPath = getWebServiceConfigPath();
  assert.ok(configPath.endsWith(path.join(".omp", "agent", "web-service.json")) || configPath.endsWith("web-service.json"));
});

test("getWebServiceLogPath returns expected log path", () => {
  const logPath = getWebServiceLogPath();
  assert.ok(logPath.endsWith(path.join("logs", "omp-web-service.log")));
});

test("getWindowsShortcutPaths returns expected .lnk shortcut locations", () => {
  const shortcuts = getWindowsShortcutPaths();
  assert.ok(shortcuts.desktop.endsWith(path.join("Desktop", "foxnio.lnk")));
  assert.ok(shortcuts.startMenu.endsWith(path.join("Programs", "foxnio.lnk")));
  assert.ok(shortcuts.startup.endsWith(path.join("Startup", "foxnio-tray.lnk")));
});

test("getAppVersion returns package version string", () => {
  const ver = getAppVersion();
  assert.match(ver, /^\d+\.\d+\.\d+/);
});

test("getWebServiceStatus returns a complete status object", async () => {
  const status = await getWebServiceStatus();
  assert.equal(typeof status.isWindows, "boolean");
  assert.equal(typeof status.isInstalled, "boolean");
  assert.equal(typeof status.autostart, "boolean");
  assert.equal(typeof status.isRunning, "boolean");
  assert.equal(typeof status.port, "number");
  assert.equal(typeof status.hostname, "string");
  assert.ok(status.mode === "start" || status.mode === "dev");
  assert.equal(typeof status.desktopShortcutExists, "boolean");
  assert.equal(typeof status.startMenuShortcutExists, "boolean");
  assert.equal(typeof status.startupShortcutExists, "boolean");
  assert.equal(typeof status.logFile, "string");
  assert.equal(typeof status.configFile, "string");
  assert.equal(typeof status.serviceUrl, "string");
  assert.equal(typeof status.version, "string");
  assert.ok(status.serviceUrl.startsWith("http://"));
});

test("getRepoRoot resolves valid repository directory containing package.json", () => {
  const repo = getRepoRoot();
  assert.equal(typeof repo, "string");
  assert.ok(repo.length > 0);
});

test("getSystemRoot returns a valid root path", () => {
  const sysRoot = getSystemRoot();
  assert.equal(typeof sysRoot, "string");
  assert.ok(sysRoot.length > 0);
});

test("binary resolution helpers return valid executable paths on Windows", () => {
  const psBin = resolvePowerShellBin();
  const wscriptBin = resolveWscriptBin();
  const taskkillBin = resolveTaskkillBin();

  assert.equal(typeof psBin, "string");
  assert.equal(typeof wscriptBin, "string");
  assert.equal(typeof taskkillBin, "string");

  if (process.platform === "win32") {
    assert.match(psBin.toLowerCase(), /(powershell|pwsh)(\.exe)?/);
    assert.match(wscriptBin.toLowerCase(), /wscript(\.exe)?/);
    assert.match(taskkillBin.toLowerCase(), /taskkill(\.exe)?/);
  }
});

test("getWindowsExecutionEnv includes System32 and PowerShell paths in PATH on Windows", () => {
  const env = getWindowsExecutionEnv();
  assert.ok(env);
  if (process.platform === "win32") {
    const pathVal = env.PATH || env.Path || "";
    assert.match(pathVal.toLowerCase(), /system32/);
    assert.match(pathVal.toLowerCase(), /windowspowershell/);
    assert.ok(env.SystemRoot);
  }
});

test("isTrayProcessRunning caches status and refreshes on invalidateTrayRunningCache", async () => {
  invalidateTrayRunningCache();
  const running1 = await isTrayProcessRunning();
  assert.equal(typeof running1, "boolean");

  const running2 = await isTrayProcessRunning();
  assert.equal(running1, running2);

  invalidateTrayRunningCache();
  const running3 = await isTrayProcessRunning();
  assert.equal(typeof running3, "boolean");
});
