"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { classifyNavigation } = require("./external-url.cjs");

const origin = "http://127.0.0.1:30177";

test("keeps same-origin URLs inside the app", () => {
  assert.equal(classifyNavigation("http://127.0.0.1:30177/session/1?x=1", origin), "internal");
  // A blob URL carries the origin that created it.
  assert.equal(classifyNavigation("blob:http://127.0.0.1:30177/abc", origin), "internal");
});

test("opens web and mail links externally, including other ports on the same host", () => {
  assert.equal(classifyNavigation("https://github.com/telagod/foxnio", origin), "external");
  assert.equal(classifyNavigation("http://example.com", origin), "external");
  assert.equal(classifyNavigation("mailto:someone@example.com", origin), "external");
  assert.equal(classifyNavigation("http://127.0.0.1:3000/", origin), "external");
});

test("denies schemes that could run code or reach the file system", () => {
  for (const url of [
    "file:///C:/Users/me/Downloads/setup.exe",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,<script>1</script>",
    "ms-msdt:/id PCWDiagnostic",
    "smb://attacker/share",
    "vscode://file/etc/passwd",
    "about:blank",
  ]) {
    assert.equal(classifyNavigation(url, origin), "deny", url);
  }
});

test("denies URLs that do not parse", () => {
  for (const url of ["", "not a url", "http://", "//host/path", undefined, null]) {
    assert.equal(classifyNavigation(url, origin), "deny", String(url));
  }
});
