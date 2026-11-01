import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { composerEnterAction } = await jiti.import("./ChatInput-expand.ts");

const keys = { shiftKey: false, ctrlKey: false, metaKey: false };

test("compact composer: Enter sends on desktop, newlines on mobile, Shift+Enter always newlines", () => {
  assert.equal(composerEnterAction({ expanded: false, isMobile: false, ...keys }), "send");
  assert.equal(composerEnterAction({ expanded: false, isMobile: true, ...keys }), "newline");
  assert.equal(composerEnterAction({ expanded: false, isMobile: false, ...keys, shiftKey: true }), "newline");
});

test("expanded editor: bare Enter inserts a newline on every breakpoint", () => {
  assert.equal(composerEnterAction({ expanded: true, isMobile: false, ...keys }), "newline");
  assert.equal(composerEnterAction({ expanded: true, isMobile: true, ...keys }), "newline");
});

test("expanded editor: Ctrl+Enter and Cmd+Enter send, Shift keeps the newline", () => {
  assert.equal(composerEnterAction({ expanded: true, isMobile: false, ...keys, ctrlKey: true }), "send");
  assert.equal(composerEnterAction({ expanded: true, isMobile: false, ...keys, metaKey: true }), "send");
  assert.equal(composerEnterAction({ expanded: true, isMobile: true, ...keys, ctrlKey: true }), "send");
  assert.equal(composerEnterAction({ expanded: true, isMobile: false, ...keys, ctrlKey: true, shiftKey: true }), "newline");
});

test("expanded menus take at most 360px and half the viewport", async () => {
  const { expandedMenuMaxHeight } = await jiti.import("./ChatInput-expand.ts");
  assert.equal(expandedMenuMaxHeight(1000), 360);
  assert.equal(expandedMenuMaxHeight(500), 250);
  assert.equal(expandedMenuMaxHeight(0), 0);
});
