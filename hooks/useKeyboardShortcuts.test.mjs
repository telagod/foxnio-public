import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { isToggleSidebarShortcut } = await jiti.import("./useKeyboardShortcuts.ts");

const key = (init) => ({ key: "b", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, defaultPrevented: false, ...init });

test("Cmd+B toggles the sidebar on macOS, Ctrl+B elsewhere", () => {
  assert.equal(isToggleSidebarShortcut(key({ metaKey: true }), true), true);
  assert.equal(isToggleSidebarShortcut(key({ ctrlKey: true }), true), false, "Ctrl+B is cursor-left in macOS text fields");
  assert.equal(isToggleSidebarShortcut(key({ ctrlKey: true }), false), true);
  assert.equal(isToggleSidebarShortcut(key({ metaKey: true }), false), false);
  assert.equal(isToggleSidebarShortcut(key({ ctrlKey: true, key: "B" }), false), true, "caps lock or shift-less uppercase");
});

test("extra modifiers, other keys, IME composition and handled events are not the shortcut", () => {
  assert.equal(isToggleSidebarShortcut(key({ ctrlKey: true, shiftKey: true }), false), false);
  assert.equal(isToggleSidebarShortcut(key({ ctrlKey: true, altKey: true }), false), false);
  assert.equal(isToggleSidebarShortcut(key({ ctrlKey: true, metaKey: true }), false), false);
  assert.equal(isToggleSidebarShortcut(key({ ctrlKey: true, key: "n" }), false), false);
  assert.equal(isToggleSidebarShortcut(key({ ctrlKey: true, isComposing: true }), false), false);
  assert.equal(isToggleSidebarShortcut(key({ ctrlKey: true, defaultPrevented: true }), false), false);
  assert.equal(isToggleSidebarShortcut(key({}), false), false);
});
