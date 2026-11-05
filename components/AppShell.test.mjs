import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const layout = await jiti.import("./AppShell-layout.tsx");

test("sidebar drag scales pointer deltas by the interface zoom", () => {
  // clientX is viewport pixels while --sidebar-width is zoomed layout pixels;
  // without the correction the edge overshoots at 110/120% scale.
  assert.equal(layout.dragSidebarWidth(280, 500, 560, 1), 340);
  assert.equal(layout.dragSidebarWidth(280, 500, 560, 1.2), 330);
  assert.equal(layout.dragSidebarWidth(300, 500, 460, 0.8), 250, "zoom below 1 enlarges the delta");
  // The result is always inside the allowed range.
  assert.equal(layout.dragSidebarWidth(280, 0, 5000, 1), layout.SIDEBAR_MAX_WIDTH);
  assert.equal(layout.dragSidebarWidth(280, 0, -5000, 1), layout.SIDEBAR_MIN_WIDTH);
});

test("the interface scale is read from the --ui-scale custom property", () => {
  const root = document.documentElement;
  assert.equal(layout.readUiScale(), 1);
  root.style.setProperty("--ui-scale", "1.25");
  assert.equal(layout.readUiScale(), 1.25);
  root.style.setProperty("--ui-scale", "garbage");
  assert.equal(layout.readUiScale(), 1);
  root.style.setProperty("--ui-scale", "0");
  assert.equal(layout.readUiScale(), 1);
  root.style.removeProperty("--ui-scale");
});

test("sidebar keyboard resizing: arrows 12 px, Shift 32, Home/End limits, Enter resets", () => {
  assert.equal(layout.sidebarWidthForKey("ArrowRight", false, 300), 312);
  assert.equal(layout.sidebarWidthForKey("ArrowLeft", false, 300), 288);
  assert.equal(layout.sidebarWidthForKey("ArrowRight", true, 300), 332);
  assert.equal(layout.sidebarWidthForKey("ArrowLeft", true, 300), 268);
  assert.equal(layout.sidebarWidthForKey("ArrowLeft", true, layout.SIDEBAR_MIN_WIDTH + 5), layout.SIDEBAR_MIN_WIDTH);
  assert.equal(layout.sidebarWidthForKey("ArrowRight", false, layout.SIDEBAR_MAX_WIDTH - 5), layout.SIDEBAR_MAX_WIDTH);
  assert.equal(layout.sidebarWidthForKey("Home", false, 300), layout.SIDEBAR_MIN_WIDTH);
  assert.equal(layout.sidebarWidthForKey("End", false, 300), layout.SIDEBAR_MAX_WIDTH);
  assert.equal(layout.sidebarWidthForKey("Enter", false, 400), layout.SIDEBAR_DEFAULT_WIDTH);
  assert.equal(layout.sidebarWidthForKey("a", false, 300), null);
  assert.equal(layout.sidebarWidthForKey("ArrowUp", false, 300), null);
});

test("the stored sidebar width is clamped and falls back to the default", () => {
  localStorage.removeItem(layout.SIDEBAR_WIDTH_STORAGE_KEY);
  assert.equal(layout.loadSidebarWidth(), layout.SIDEBAR_DEFAULT_WIDTH);
  localStorage.setItem(layout.SIDEBAR_WIDTH_STORAGE_KEY, "9999");
  assert.equal(layout.loadSidebarWidth(), layout.SIDEBAR_MAX_WIDTH);
  localStorage.setItem(layout.SIDEBAR_WIDTH_STORAGE_KEY, "100");
  assert.equal(layout.loadSidebarWidth(), layout.SIDEBAR_MIN_WIDTH);
  localStorage.setItem(layout.SIDEBAR_WIDTH_STORAGE_KEY, "nope");
  assert.equal(layout.loadSidebarWidth(), layout.SIDEBAR_DEFAULT_WIDTH);
  localStorage.removeItem(layout.SIDEBAR_WIDTH_STORAGE_KEY);
});

test("the expand-thinking preference reaches the thinking block, off unless stored", async () => {
  const appShell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  const settings = await readFile(new URL("./SettingsConfig.tsx", import.meta.url), "utf8");
  const chatWindow = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  const messageView = await readFile(new URL("./MessageView.tsx", import.meta.url), "utf8");

  // Stored like the tool-call preference, and only "true" turns it on.
  assert.match(appShell, /EXPAND_THINKING_STORAGE_KEY = "omp-web:expand-thinking"/);
  assert.match(appShell, /useState\(false\)/);
  assert.match(appShell, /setExpandThinkingByDefault\(window\.localStorage\.getItem\(EXPAND_THINKING_STORAGE_KEY\) === "true"\)/);
  assert.match(appShell, /window\.localStorage\.setItem\(EXPAND_THINKING_STORAGE_KEY, String\(expand\)\)/);
  // AppShell hands it to Settings and to the chat (a missing prop leaves the
  // setting inert, which is what the tool-call preference already taught).
  assert.match(appShell, /expandThinkingByDefault=\{expandThinkingByDefault\}/);
  assert.match(appShell, /onExpandThinkingByDefaultChange=\{handleExpandThinkingByDefaultChange\}/);
  // ChatWindow forwards it to both MessageView hosts; MessageView seeds the state.
  assert.equal(chatWindow.match(/expandThinkingByDefault=\{expandThinkingByDefault\}/g)?.length, 3);
  assert.match(messageView, /const \[expanded, setExpanded\] = useState\(expandByDefault\)/);
  // The toggle sits next to "Keep tool calls collapsed" and is searchable.
  assert.match(settings, /searchId="keep-tool-calls-collapsed"[\s\S]{0,400}searchId="expand-thinking-by-default"/);
  assert.match(settings, /id: "expand-thinking-by-default", tab: "general"/);
  assert.match(settings, /<ToggleSwitch checked=\{expandThinkingByDefault\} onChange=\{onExpandThinkingByDefaultChange\} \/>/);
});

test("every locale carries the expand-thinking setting copy", async () => {
  for (const locale of ["en", "zh-CN", "ja"]) {
    const messages = JSON.parse(await readFile(new URL(`../lib/i18n/locales/${locale}.json`, import.meta.url), "utf8"));
    assert.ok(messages["settingsConfig.expandThinkingByDefault"], `${locale} label`);
    assert.ok(messages["settingsConfig.expandThinkingByDefaultDesc"], `${locale} description`);
  }
});

test("the fold-completed-turns preference reaches the chat, on unless stored as false", async () => {
  const appShell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  const settings = await readFile(new URL("./SettingsConfig.tsx", import.meta.url), "utf8");
  const chatWindow = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

  assert.match(appShell, /FOLD_COMPLETED_TURNS_STORAGE_KEY = "omp-web:fold-completed-turns"/);
  assert.match(appShell, /setFoldCompletedTurns\(window\.localStorage\.getItem\(FOLD_COMPLETED_TURNS_STORAGE_KEY\) !== "false"\)/);
  assert.match(appShell, /window\.localStorage\.setItem\(FOLD_COMPLETED_TURNS_STORAGE_KEY, String\(fold\)\)/);
  // A missing prop would leave the setting inert, so both consumers must receive it.
  assert.match(appShell, /foldCompletedTurns=\{foldCompletedTurns\}\s+onFoldCompletedTurnsChange=\{handleFoldCompletedTurnsChange\}/);
  assert.equal(appShell.match(/foldCompletedTurns=\{foldCompletedTurns\}/g)?.length, 2, "Settings and ChatWindow");
  assert.match(chatWindow, /foldCompletedTurns=\{foldCompletedTurns\}/);
  assert.match(settings, /id: "fold-completed-turns", tab: "general"/);
  assert.match(settings, /<ToggleSwitch checked=\{foldCompletedTurns\} onChange=\{onFoldCompletedTurnsChange\} \/>/);
});

test("every locale carries the fold-completed-turns copy and the summary row labels", async () => {
  for (const locale of ["en", "zh-CN", "ja"]) {
    const messages = JSON.parse(await readFile(new URL(`../lib/i18n/locales/${locale}.json`, import.meta.url), "utf8"));
    for (const key of [
      "settingsConfig.foldCompletedTurns",
      "settingsConfig.foldCompletedTurnsDesc",
      "chatWindow.completedSteps.one",
      "chatWindow.completedSteps.other",
      "chatWindow.thinkingBlockCount.one",
      "chatWindow.thinkingBlockCount.other",
    ]) assert.ok(messages[key], `${locale} ${key}`);
  }
});
