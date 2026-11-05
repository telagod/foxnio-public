import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { isNewerVersion, detectInstallMethod, checkNpmUpdate } = jiti("./npm-update.ts");
const packageVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

test("recognizes newer package versions", () => {
  assert.equal(isNewerVersion("0.2.1", "0.2.0"), true);
  assert.equal(isNewerVersion("1.0.0", "0.9.9"), true);
  assert.equal(isNewerVersion("v1.0.1", "1.0.0"), true);
  assert.equal(isNewerVersion("0.2.0", "0.2.0"), false);
  assert.equal(isNewerVersion("0.1.9", "0.2.0"), false);
});

test("only treats a stable build as newer than the matching prerelease", () => {
  assert.equal(isNewerVersion("0.2.0", "0.2.0-beta.1"), true);
  assert.equal(isNewerVersion("0.2.0-beta.2", "0.2.0"), false);
  assert.equal(isNewerVersion("latest", "0.2.0"), false);
});

test("rejects versions that carry shell metacharacters or whitespace", () => {
  assert.equal(isNewerVersion("9.0.0-x&calc", "0.2.0"), false);
  assert.equal(isNewerVersion("9.0.0-x calc", "0.2.0"), false);
  assert.equal(isNewerVersion("9.0.0-$(id)", "0.2.0"), false);
  assert.equal(isNewerVersion("9.0.0-rc.1", "0.2.0"), true);
  // A malformed current version must not make any release look newer either.
  assert.equal(isNewerVersion("9.0.0", "0.2.0-x;y"), false);
});

test("does not offer a release tag that is not a well-formed version", async () => {
  const originalFetch = globalThis.fetch;
  const originalDisabled = process.env.OMP_WEB_DISABLE_AUTOUPDATE;
  delete process.env.OMP_WEB_DISABLE_AUTOUPDATE;
  globalThis.fetch = async () => new Response(JSON.stringify({ tag_name: "v99.0.0-x&calc" }), { status: 200 });
  try {
    const status = await checkNpmUpdate(true);
    assert.equal(status.availableVersion, null);
    assert.equal(status.updateAvailable, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDisabled === undefined) delete process.env.OMP_WEB_DISABLE_AUTOUPDATE;
    else process.env.OMP_WEB_DISABLE_AUTOUPDATE = originalDisabled;
  }
});

test("checks GitHub Releases for the latest foxnio version", async () => {
  const originalFetch = globalThis.fetch;
  const originalDisabled = process.env.OMP_WEB_DISABLE_AUTOUPDATE;
  const releaseVersion = `${Number(packageVersion.split(".")[0]) + 1}.0.0`;
  let requestUrl = "";
  delete process.env.OMP_WEB_DISABLE_AUTOUPDATE;
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    assert.equal(new Headers(init?.headers).get("accept"), "application/vnd.github+json");
    return new Response(JSON.stringify({ tag_name: `v${releaseVersion}` }), { status: 200 });
  };

  try {
    const status = await checkNpmUpdate(true);
    assert.equal(requestUrl, "https://api.github.com/repos/telagod/foxnio-public/releases/latest");
    assert.equal(status.availableVersion, releaseVersion);
    assert.equal(status.updateAvailable, true);
    assert.equal(status.updateCommand, "npm install -g @telagod/foxnio");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDisabled === undefined) delete process.env.OMP_WEB_DISABLE_AUTOUPDATE;
    else process.env.OMP_WEB_DISABLE_AUTOUPDATE = originalDisabled;
  }
});

test("detectInstallMethod routes bun-global installs to bun", () => {
  process.env.USERPROFILE = "C:\\Users\\khaled";
  assert.equal(detectInstallMethod("C:\\Users\\khaled\\node_modules\\@telagod\\foxnio"), "bun");
  assert.equal(detectInstallMethod("C:\\Users\\khaled\\node_modules\\.bin\\foxnio.cmd"), "bun");
  // Mixed separators (Windows-style path on a POSIX host, e.g. CI) must classify identically.
  assert.equal(detectInstallMethod("C:/Users/khaled/node_modules/@telagod/foxnio"), "bun");
});

test("detectInstallMethod falls back to npm for anything else", () => {
  process.env.USERPROFILE = "C:\\Users\\khaled";
  assert.equal(detectInstallMethod("C:\\Users\\khaled\\AppData\\Roaming\\npm\\node_modules\\@telagod\\foxnio"), "npm");
  assert.equal(detectInstallMethod("C:\\Program Files\\nodejs\\node_modules\\@telagod\\foxnio"), "npm");
  assert.equal(detectInstallMethod("D:\\OtherProjects\\foxnio"), "npm");
});
