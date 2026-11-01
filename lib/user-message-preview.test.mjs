import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  USER_MESSAGE_PREVIEW_LINES,
  countContentLines,
  hiddenPreviewLines,
  userMessagePreviewMaxHeight,
} = await jiti.import("./user-message-preview.ts");

test("counts only lines that carry text, across newline styles", () => {
  assert.equal(countContentLines(""), 0);
  assert.equal(countContentLines("one"), 1);
  assert.equal(countContentLines("one\n\n\ntwo\n"), 2);
  assert.equal(countContentLines("a\r\nb\rc\nd"), 4);
  assert.equal(countContentLines("  \n\t\nreal"), 1);
});

test("hides nothing for a message that fits the preview", () => {
  assert.equal(hiddenPreviewLines("a\nb\nc"), 0);
  assert.equal(hiddenPreviewLines("a single very long paragraph"), 0);
});

test("reports the lines beyond the preview", () => {
  assert.equal(USER_MESSAGE_PREVIEW_LINES, 3);
  assert.equal(hiddenPreviewLines("1\n2\n3\n4"), 1);
  assert.equal(hiddenPreviewLines("1\n\n2\n\n3\n\n4\n5\n6"), 3);
  assert.equal(hiddenPreviewLines("1\n2\n3\n4\n5", 1), 4);
});

test("preview height is expressed in lines of the user bubble font", () => {
  assert.equal(
    userMessagePreviewMaxHeight(),
    "calc(3 * var(--chat-user-font-size) * var(--chat-line-height) + 16px)",
  );
  assert.equal(
    userMessagePreviewMaxHeight(1),
    "calc(1 * var(--chat-user-font-size) * var(--chat-line-height) + 16px)",
  );
});
