import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { cleanup, renderHook } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  KEYBOARD_MIN_DELTA_PX,
  KEYBOARD_OPEN_ATTRIBUTE,
  VIEWPORT_HEIGHT_PROPERTY,
  computeViewport,
  isTextEntry,
  useViewportHeight,
} = await jiti.import("./useViewportHeight.ts");

const root = document.documentElement;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  cleanup();
  delete window.visualViewport;
  document.body.replaceChildren();
  root.style.removeProperty(VIEWPORT_HEIGHT_PROPERTY);
  root.removeAttribute(KEYBOARD_OPEN_ATTRIBUTE);
});

test("the override exists only while an editable element is focused and the keyboard took a real bite", () => {
  const closed = { baselineHeight: 800, visibleHeight: 800, editableFocused: true };
  assert.deepEqual(computeViewport(closed), { keyboardOpen: false, height: null });
  assert.deepEqual(computeViewport({ baselineHeight: 800, visibleHeight: 800 - KEYBOARD_MIN_DELTA_PX, editableFocused: true }), { keyboardOpen: false, height: null }, "browser chrome sized change");
  assert.deepEqual(computeViewport({ baselineHeight: 800, visibleHeight: 500.4, editableFocused: true }), { keyboardOpen: true, height: 500 });
  assert.deepEqual(computeViewport({ baselineHeight: 800, visibleHeight: 500, editableFocused: false }), { keyboardOpen: false, height: null }, "no field focused: the layout viewport rules");
});

test("only text-entry elements raise the on-screen keyboard", () => {
  assert.equal(isTextEntry("TEXTAREA", null, false), true);
  assert.equal(isTextEntry("INPUT", "text", false), true);
  assert.equal(isTextEntry("INPUT", "search", false), true);
  assert.equal(isTextEntry("INPUT", null, false), true);
  assert.equal(isTextEntry("INPUT", "checkbox", false), false);
  assert.equal(isTextEntry("INPUT", "RADIO", false), false);
  assert.equal(isTextEntry("INPUT", "range", false), false);
  assert.equal(isTextEntry("BUTTON", null, false), false);
  assert.equal(isTextEntry("DIV", null, true), true);
  assert.equal(isTextEntry("TEXTAREA", null, false, true), false, "read-only fields show no keyboard");
});

function fakeVisualViewport(height, offsetTop = 0) {
  const target = new window.EventTarget();
  target.height = height;
  target.offsetTop = offsetTop;
  return target;
}

test("focusing a field while the visual viewport shrinks publishes the height and the attribute, blur clears them", async () => {
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  const viewport = fakeVisualViewport(800);
  window.visualViewport = viewport;
  renderHook(() => useViewportHeight());
  assert.equal(root.style.getPropertyValue(VIEWPORT_HEIGHT_PROPERTY), "");

  const field = document.createElement("textarea");
  document.body.append(field);
  field.focus();
  viewport.height = 480;
  viewport.dispatchEvent(new window.Event("resize"));
  assert.equal(root.style.getPropertyValue(VIEWPORT_HEIGHT_PROPERTY), "480px");
  assert.equal(root.hasAttribute(KEYBOARD_OPEN_ATTRIBUTE), true);

  // The keyboard keeps animating; later reads follow it.
  viewport.height = 450;
  await delay(80);
  assert.equal(root.style.getPropertyValue(VIEWPORT_HEIGHT_PROPERTY), "450px");

  field.blur();
  viewport.height = 800;
  viewport.dispatchEvent(new window.Event("resize"));
  assert.equal(root.style.getPropertyValue(VIEWPORT_HEIGHT_PROPERTY), "");
  assert.equal(root.hasAttribute(KEYBOARD_OPEN_ATTRIBUTE), false);
});

test("a shrunken visual viewport without a focused field (browser chrome) is ignored", () => {
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  const viewport = fakeVisualViewport(800);
  window.visualViewport = viewport;
  renderHook(() => useViewportHeight());
  viewport.height = 500;
  viewport.dispatchEvent(new window.Event("resize"));
  assert.equal(root.style.getPropertyValue(VIEWPORT_HEIGHT_PROPERTY), "");
  assert.equal(root.hasAttribute(KEYBOARD_OPEN_ATTRIBUTE), false);
});

test("unmounting removes the override and the listeners", () => {
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  const viewport = fakeVisualViewport(800);
  window.visualViewport = viewport;
  const hook = renderHook(() => useViewportHeight());
  const field = document.createElement("input");
  document.body.append(field);
  field.focus();
  viewport.height = 450;
  viewport.dispatchEvent(new window.Event("resize"));
  assert.equal(root.style.getPropertyValue(VIEWPORT_HEIGHT_PROPERTY), "450px");
  hook.unmount();
  assert.equal(root.style.getPropertyValue(VIEWPORT_HEIGHT_PROPERTY), "");
  assert.equal(root.hasAttribute(KEYBOARD_OPEN_ATTRIBUTE), false);
  viewport.height = 300;
  viewport.dispatchEvent(new window.Event("resize"));
  assert.equal(root.style.getPropertyValue(VIEWPORT_HEIGHT_PROPERTY), "", "nothing listens any more");
});

test("browsers without visualViewport are left alone", () => {
  delete window.visualViewport;
  renderHook(() => useViewportHeight());
  assert.equal(root.style.getPropertyValue(VIEWPORT_HEIGHT_PROPERTY), "");
});
