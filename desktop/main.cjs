"use strict";

const { app, BrowserWindow, Menu, Tray, dialog, nativeImage, shell } = require("electron");
const http = require("node:http");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { resolveNodeBinary } = require("./node-runtime.cjs");

const gotSingleInstance = app.requestSingleInstanceLock();
if (!gotSingleInstance) {
  app.quit();
}

const HOSTNAME = "127.0.0.1";
const DEFAULT_PORT = 30177;
const STARTUP_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 250;

let mainWindow = null;
let tray = null;
let serverProcess = null;
let serverUrl = null;
let isQuitting = false;

function desktopPort(env = process.env) {
  const raw = env.OMP_WEB_DESKTOP_PORT ?? env.PORT ?? String(DEFAULT_PORT);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid desktop port: ${raw}`);
  }
  return port;
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

async function waitForServer(url, child, timeoutMs = STARTUP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not ready";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`foxnio server exited before becoming ready (code ${child.exitCode ?? "unknown"})`);
    }
    try {
      const status = await requestServer(url);
      if (status >= 200 && status < 500) return;
      lastError = `HTTP ${status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`Timed out waiting for foxnio at ${url}: ${lastError}`);
}

function terminateServer() {
  const child = serverProcess;
  serverProcess = null;
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32" && Number.isInteger(child.pid)) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  child.kill("SIGTERM");
}

function openServerWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  mainWindow.focus();
}

function createTray(appRoot) {
  const iconPath = path.join(appRoot, "public", process.platform === "win32" ? "omp-web.ico" : "icon.png");
  if (!existsSync(iconPath)) return;
  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) return;
  tray = new Tray(image);
  tray.setToolTip("foxnio");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开 foxnio", click: openServerWindow },
    { type: "separator" },
    { label: "退出", click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on("click", openServerWindow);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: "foxnio",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const allowedOrigin = new URL(serverUrl).origin;
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (new URL(url).origin === allowedOrigin) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin === allowedOrigin) return;
    event.preventDefault();
    void shell.openExternal(url);
  });
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  if (process.env.FOXNIO_DESKTOP_SMOKE_TEST === "1") {
    mainWindow.webContents.once("did-finish-load", () => {
      setTimeout(() => {
        isQuitting = true;
        app.quit();
      }, 250);
    });
  }
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.loadURL(serverUrl).catch((error) => {
    dialog.showErrorBox("foxnio 启动失败", `无法加载本地服务：${error.message}`);
    isQuitting = true;
    app.quit();
  });
}

function resolveAppRoot() {
  const appPath = app.getAppPath();
  if (existsSync(path.join(appPath, "bin", "omp-web.js"))) return appPath;
  const parent = path.dirname(appPath);
  if (existsSync(path.join(parent, "bin", "omp-web.js"))) return parent;
  return appPath;
}

async function start() {
  const appRoot = resolveAppRoot();
  const port = desktopPort();
  const node = resolveNodeBinary({
    appRoot,
    resourcesPath: process.resourcesPath,
  });
  const launcher = path.join(appRoot, "bin", "omp-web.js");
  if (!existsSync(launcher)) throw new Error(`foxnio launcher not found: ${launcher}`);

  serverUrl = `http://${HOSTNAME}:${port}`;
  serverProcess = spawn(node, [launcher, "--no-open", "--port", String(port), "--hostname", HOSTNAME], {
    cwd: appRoot,
    env: {
      ...process.env,
      OMP_WEB_NO_OPEN: "1",
      OMP_WEB_HOSTNAME: HOSTNAME,
      OMP_WEB_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  serverProcess.stdout?.on("data", (chunk) => process.stdout.write(`[foxnio] ${chunk}`));
  serverProcess.stderr?.on("data", (chunk) => process.stderr.write(`[foxnio] ${chunk}`));
  serverProcess.once("error", (error) => {
    if (!isQuitting) console.error(`foxnio server error: ${error.message}`);
  });
  serverProcess.once("exit", (code, signal) => {
    if (!isQuitting && mainWindow && !mainWindow.isDestroyed()) {
      dialog.showErrorBox("foxnio 已停止", `本地服务已退出（${signal ?? `code ${code ?? "unknown"}`}）。`);
      isQuitting = true;
      app.quit();
    }
  });

  await waitForServer(serverUrl, serverProcess);
  createWindow();
  createTray(appRoot);
}

if (gotSingleInstance) {
  app.on("second-instance", () => openServerWindow());
  app.whenReady().then(() => start()).catch((error) => {
    console.error(error);
    dialog.showErrorBox("foxnio 启动失败", error instanceof Error ? error.message : String(error));
    isQuitting = true;
    app.quit();
  });

  app.on("activate", () => {
    if (mainWindow && !mainWindow.isDestroyed()) openServerWindow();
  });
  app.on("before-quit", () => {
    isQuitting = true;
    terminateServer();
    tray?.destroy();
    tray = null;
  });
  app.on("window-all-closed", () => {
    // Keep the local Agent service alive behind the tray until the user chooses Exit.
  });
}

module.exports = { desktopPort, requestServer, waitForServer };
