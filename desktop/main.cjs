"use strict";

const { app, BrowserWindow, Menu, Tray, dialog, nativeImage, shell } = require("electron");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { isPortAvailable } = require("../bin/port-availability.js");
const { classifyNavigation } = require("./external-url.cjs");
const { resolveNodeBinary } = require("./node-runtime.cjs");
const { DEFAULT_PORT, choosePort, waitForServer } = require("./startup.cjs");

const gotSingleInstance = app.requestSingleInstanceLock();
if (!gotSingleInstance) {
  app.quit();
}

const HOSTNAME = "127.0.0.1";

let mainWindow = null;
let tray = null;
let serverProcess = null;
let serverUrl = null;
let isQuitting = false;

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
    const target = classifyNavigation(url, allowedOrigin);
    if (target === "internal") return { action: "allow" };
    if (target === "external") void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const target = classifyNavigation(url, allowedOrigin);
    if (target === "internal") return;
    event.preventDefault();
    if (target === "external") void shell.openExternal(url);
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
  const { port, fellBack } = await choosePort({
    isPortAvailable: (candidate) => isPortAvailable(candidate, HOSTNAME),
  });
  if (fellBack) console.warn(`[foxnio] Port ${DEFAULT_PORT} is in use; using ${port}. UI preferences are stored per port.`);
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
      // The launcher belongs to this app; the in-app updater would stop it and
      // leave the window without a server. Updates arrive as new installers.
      OMP_WEB_DISABLE_AUTOUPDATE: "1",
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

