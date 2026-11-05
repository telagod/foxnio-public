import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { NextRequest } = await import("next/server.js");
const { unstable_doesMiddlewareMatch } = await import("next/experimental/testing/server.js");
const {
  createWebSession,
  verifyWebPassword,
  isValidWebSession,
  isWebPasswordEnabled,
  webPasswordConfigurationProblem,
} = await jiti.import("./web-auth.ts");
const { hashPassword } = await jiti.import("./web-password-hash.ts");
const {
  deriveSessionSigningKey,
  resetWebAuthSecretCache,
  pinWebAuthSecretForTests,
  webAuthSecretPath,
} = await jiti.import("./web-auth-secret.ts");
const { config, proxy } = await jiti.import("../proxy.ts");

const PASSWORD = "correct horse battery staple";
// N = 2^12 for the test suite: the format and code path are identical, only
// the cost differs, and a full-cost hash per test would dominate the run.
const PASSWORD_HASH = hashPassword(PASSWORD, { logN: 12 });
const TEST_SECRET = { salt: "a".repeat(43), key: "b".repeat(43) };

// `run` may be async: the environment is restored once its promise settles.
function withEnvVars(values, run) {
  const saved = new Map();
  for (const name of ["OMP_WEB_PASSWORD_HASH", "OMP_WEB_PASSWORD"]) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  for (const [name, value] of Object.entries(values)) process.env[name] = value;
  pinWebAuthSecretForTests(TEST_SECRET);
  const restore = () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    pinWebAuthSecretForTests();
  };
  let result;
  try {
    result = run();
  } catch (error) {
    restore();
    throw error;
  }
  if (typeof result?.then !== "function") {
    restore();
    return result;
  }
  return result.finally(restore);
}

test("accepts only the hashed password and validates signed sessions", async () => {
  await withEnvVars({ OMP_WEB_PASSWORD_HASH: PASSWORD_HASH }, async () => {
    assert.equal(isWebPasswordEnabled(), true);
    assert.equal(await verifyWebPassword(PASSWORD), true);
    assert.equal(await verifyWebPassword("wrong"), false);
    assert.equal(await verifyWebPassword(""), false);

    const now = 1_700_000_000_000;
    const session = createWebSession(now);
    assert.equal(isValidWebSession(session, now), true);
    assert.equal(isValidWebSession(session, now + 31 * 24 * 60 * 60 * 1000), false);
    assert.equal(isValidWebSession("v1.1.aaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", now), false);
    assert.equal(isValidWebSession(undefined, now), false);
  });
});

test("a different password hash invalidates existing sessions", () => {
  const now = 1_700_000_000_000;
  const first = withEnvVars({ OMP_WEB_PASSWORD_HASH: PASSWORD_HASH }, () => createWebSession(now));
  withEnvVars({ OMP_WEB_PASSWORD_HASH: hashPassword("rotated", { logN: 12 }) }, () => {
    assert.equal(isValidWebSession(first, now), false);
  });
  // ...and the same hash plus the same installation secret keeps working.
  withEnvVars({ OMP_WEB_PASSWORD_HASH: PASSWORD_HASH }, () => {
    assert.equal(isValidWebSession(first, now), true);
  });
});

test("the signing key never equals the stored hash", () => {
  // Anyone holding the hash (it sits in web-service.env) must not be able to
  // forge a session, so the cookie key is derived, not reused.
  const key = deriveSessionSigningKey(PASSWORD_HASH, TEST_SECRET);
  assert.notEqual(key, PASSWORD_HASH);
  assert.doesNotMatch(key, /scrypt/);
  const rotated = deriveSessionSigningKey(hashPassword("rotated", { logN: 12 }), TEST_SECRET);
  assert.notEqual(key, rotated);
});

test("a rotated installation secret invalidates sessions too", () => {
  const now = 1_700_000_000_000;
  const first = withEnvVars({ OMP_WEB_PASSWORD_HASH: PASSWORD_HASH }, () => createWebSession(now));
  withEnvVars({ OMP_WEB_PASSWORD_HASH: PASSWORD_HASH }, () => {
    pinWebAuthSecretForTests({ salt: "c".repeat(43), key: "d".repeat(43) });
    assert.equal(isValidWebSession(first, now), false);
  });
});

test("reports a plaintext or malformed configuration instead of running open", async () => {
  const plaintext = withEnvVars({ OMP_WEB_PASSWORD: "secret" }, () => webPasswordConfigurationProblem());
  assert.match(plaintext ?? "", /no longer accepted/);
  assert.match(plaintext ?? "", /hash-password/);

  const malformed = withEnvVars({ OMP_WEB_PASSWORD_HASH: "not-a-hash" }, () => webPasswordConfigurationProblem());
  assert.match(malformed ?? "", /not a valid password hash/);

  const both = withEnvVars({ OMP_WEB_PASSWORD_HASH: PASSWORD_HASH, OMP_WEB_PASSWORD: "secret" }, () =>
    webPasswordConfigurationProblem());
  assert.match(both ?? "", /Both/);

  assert.equal(withEnvVars({ OMP_WEB_PASSWORD_HASH: PASSWORD_HASH }, () => webPasswordConfigurationProblem()), null);
  assert.equal(withEnvVars({}, () => webPasswordConfigurationProblem()), null);
  await withEnvVars({ OMP_WEB_PASSWORD: "secret" }, async () => {
    assert.equal(isWebPasswordEnabled(), false);
    assert.equal(await verifyWebPassword("secret"), false);
  });
});

test("creates and reuses an installation secret with restrictive permissions", () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-auth-secret-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const path = webAuthSecretPath();
    assert.equal(path, join(dir, "omp-web", "web-auth-secret.json"));
    resetWebAuthSecretCache();
    const key = deriveSessionSigningKey(PASSWORD_HASH);
    const stored = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(typeof stored.salt, "string");
    assert.equal(typeof stored.key, "string");
    // 43 base64url chars = 32 bytes of entropy.
    assert.match(stored.key, /^[A-Za-z0-9_-]{43}$/);
    assert.match(stored.salt, /^[A-Za-z0-9_-]{43}$/);
    if (process.platform !== "win32") {
      assert.equal(statSync(path).mode & 0o777, 0o600);
    }
    // Re-reads the same file instead of generating a new key on every call.
    resetWebAuthSecretCache();
    assert.equal(deriveSessionSigningKey(PASSWORD_HASH), key);
    // A replaced file changes the key.
    writeFileSync(path, JSON.stringify({ salt: "e".repeat(43), key: "f".repeat(43) }), { mode: 0o600 });
    resetWebAuthSecretCache();
    assert.notEqual(deriveSessionSigningKey(PASSWORD_HASH), key);
    // A corrupted file is replaced instead of locking everyone out.
    writeFileSync(path, "{ not json");
    resetWebAuthSecretCache();
    const recovered = deriveSessionSigningKey(PASSWORD_HASH);
    assert.equal(typeof recovered, "string");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).key.length, 43);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    resetWebAuthSecretCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("redirects browser requests to the password screen and blocks unauthenticated APIs", () => {
  withEnvVars({ OMP_WEB_PASSWORD_HASH: PASSWORD_HASH }, () => {
    const pageResponse = proxy(new NextRequest("http://localhost:30177/"));
    assert.equal(pageResponse.status, 307);
    assert.equal(pageResponse.headers.get("location"), "http://localhost:30177/login");

    const crossSitePageResponse = proxy(new NextRequest("http://localhost:30177/", {
      headers: { "sec-fetch-site": "cross-site" },
    }));
    assert.equal(crossSitePageResponse.status, 307);

    const apiResponse = proxy(new NextRequest("http://localhost:30177/api/sessions"));
    assert.equal(apiResponse.status, 401);

    const signedInResponse = proxy(new NextRequest("http://localhost:30177/", {
      headers: { cookie: `omp_web_session=${createWebSession()}` },
    }));
    assert.equal(signedInResponse.status, 200);
  });
});

test("refuses every request while the password configuration is broken", () => {
  withEnvVars({ OMP_WEB_PASSWORD: "legacy-plaintext" }, () => {
    for (const url of ["http://localhost:30177/", "http://localhost:30177/api/sessions", "http://localhost:30177/login"]) {
      const response = proxy(new NextRequest(url));
      assert.equal(response.status, 503, url);
    }
  });
});

test("accepts the trusted proxy header only when its SHA-256 matches the configured digest", () => {
  const previousDigest = process.env.OMP_WEB_TRUSTED_HEADER_SHA256;
  const digest = createHash("sha256").update("proxy-secret").digest("hex");
  const request = (path, value) => proxy(new NextRequest(`http://localhost:30177${path}`, {
    headers: value === undefined ? {} : { "x-omp-web-auth": value },
  }));
  withEnvVars({ OMP_WEB_PASSWORD_HASH: PASSWORD_HASH }, () => {
    try {
      process.env.OMP_WEB_TRUSTED_HEADER_SHA256 = digest;
      assert.equal(request("/", "proxy-secret").status, 200);
      assert.equal(request("/api/sessions", "proxy-secret").status, 200);
      assert.equal(request("/login", "proxy-secret").headers.get("location"), "http://localhost:30177/");
      assert.equal(request("/api/sessions", "wrong").status, 401);
      assert.equal(request("/api/sessions", "proxy-secretX").status, 401);
      assert.equal(request("/api/sessions", "proxy-secre").status, 401);
      assert.equal(request("/api/sessions", "PROXY-SECRET").status, 401);
      assert.equal(request("/api/sessions", "").status, 401);
      assert.equal(request("/api/sessions").status, 401);
      // The digest itself is not a credential.
      assert.equal(request("/api/sessions", digest).status, 401);

      process.env.OMP_WEB_TRUSTED_HEADER_SHA256 = digest.toUpperCase();
      assert.equal(request("/api/sessions", "proxy-secret").status, 200, "uppercase digest");

      // Unset, empty or malformed digest disables the header; nginx's empty value never matches.
      for (const value of [undefined, "", "proxy-secret", digest.slice(1), `${digest}0`, `${digest.slice(2)}zz`]) {
        if (value === undefined) delete process.env.OMP_WEB_TRUSTED_HEADER_SHA256;
        else process.env.OMP_WEB_TRUSTED_HEADER_SHA256 = value;
        assert.equal(request("/api/sessions", "").status, 401, String(value));
        assert.equal(request("/api/sessions", "proxy-secret").status, 401, String(value));
      }
    } finally {
      if (previousDigest === undefined) delete process.env.OMP_WEB_TRUSTED_HEADER_SHA256;
      else process.env.OMP_WEB_TRUSTED_HEADER_SHA256 = previousDigest;
    }
  });
});

test("leaves Next.js build assets outside password protection", () => {
  assert.equal(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: "/_next/static/chunks/app.js" }), false);
  assert.equal(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: "/api/sessions" }), true);
});

function withAllowedHosts(value, run) {
  const previous = process.env.OMP_WEB_ALLOWED_HOSTS;
  if (value === undefined) delete process.env.OMP_WEB_ALLOWED_HOSTS;
  else process.env.OMP_WEB_ALLOWED_HOSTS = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.OMP_WEB_ALLOWED_HOSTS;
    else process.env.OMP_WEB_ALLOWED_HOSTS = previous;
  }
}

test("without a password, the proxy refuses requests addressed to a non-loopback Host (DNS rebinding)", async () => {
  await withAllowedHosts(undefined, () => withEnvVars({}, async () => {
    // A rebinding page: Host and Origin both name the attacker's domain, so the
    // Origin check alone would pass.
    const rebound = { host: "attacker.example:30177", origin: "http://attacker.example:30177" };

    const page = proxy(new NextRequest("http://localhost:30177/", { headers: rebound }));
    assert.equal(page.status, 403);
    assert.match(page.headers.get("content-type") ?? "", /^text\/plain/);
    const text = await page.text();
    assert.match(text, /attacker\.example/);
    assert.match(text, /OMP_WEB_ALLOWED_HOSTS/);
    assert.match(text, /OMP_WEB_PASSWORD_HASH/);

    const api = proxy(new NextRequest("http://localhost:30177/api/agent/new", { method: "POST", headers: rebound }));
    assert.equal(api.status, 403);
    const body = await api.json();
    assert.equal(body.code, "host_not_allowed");
    assert.equal(typeof body.error, "string");

    // The login page is not special-cased either.
    assert.equal(proxy(new NextRequest("http://localhost:30177/login", { headers: rebound })).status, 403);

    // Loopback names keep working, with or without a port.
    for (const host of ["localhost:30177", "127.0.0.1:30177", "[::1]:30177", "dev.localhost"]) {
      assert.equal(proxy(new NextRequest("http://localhost:30177/api/sessions", { headers: { host } })).status, 200, host);
    }
  }));
});

test("OMP_WEB_ALLOWED_HOSTS lets a passwordless server answer to extra names", () => {
  withEnvVars({}, () => {
    const request = (host) => proxy(new NextRequest("http://localhost:30177/", { headers: { host } }));
    withAllowedHosts("foxnio.lan,*.example.net", () => {
      assert.equal(request("foxnio.lan:30177").status, 200);
      assert.equal(request("box.example.net").status, 200);
      assert.equal(request("example.net").status, 403);
      assert.equal(request("attacker.example").status, 403);
    });
    assert.equal(request("foxnio.lan:30177").status, 403);
  });
});

test("the Host check does not apply once a password protects the server", () => {
  withAllowedHosts(undefined, () => withEnvVars({ OMP_WEB_PASSWORD_HASH: PASSWORD_HASH }, () => {
    const headers = { host: "foxnio.example.com" };
    // Authentication, not the Host, decides: unauthenticated requests are
    // still sent to sign-in, signed-in ones pass.
    assert.equal(proxy(new NextRequest("http://localhost:30177/", { headers })).status, 307);
    assert.equal(proxy(new NextRequest("http://localhost:30177/api/sessions", { headers })).status, 401);
    const signedIn = proxy(new NextRequest("http://localhost:30177/", {
      headers: { ...headers, cookie: `omp_web_session=${createWebSession()}` },
    }));
    assert.equal(signedIn.status, 200);
  }));
});

test("a broken password configuration with a foreign Host is refused as a Host, not served", () => {
  withAllowedHosts(undefined, () => withEnvVars({ OMP_WEB_PASSWORD: "legacy-plaintext" }, () => {
    assert.equal(proxy(new NextRequest("http://localhost:30177/", { headers: { host: "attacker.example" } })).status, 403);
    assert.equal(proxy(new NextRequest("http://localhost:30177/")).status, 503);
  }));
});

test("the proxy matcher excludes only the exact public assets", () => {
  const matches = (url) => unstable_doesMiddlewareMatch({ config, nextConfig: {}, url });
  for (const url of [
    "/_next/static/chunks/app.js",
    "/favicon.ico",
    "/icon.svg",
    "/icon.png",
    "/icon-192.png",
    "/badge-96.png",
    "/sw.js",
  ]) {
    assert.equal(matches(url), false, `${url} is public`);
  }
  for (const url of [
    "/",
    "/login",
    "/api/sessions",
    // The image optimizer fetches and resizes arbitrary URLs: never public.
    "/_next/image",
    "/_next/image?url=%2Ficon.png&w=64&q=75",
    // Prefix look-alikes stay behind the proxy.
    "/_next/static",
    "/_next/staticfiles/x.js",
    "/sw.js.map",
    "/sw.json",
    "/favicon.ico.bak",
    "/icon.png/extra",
    "/icon.pngx",
    "/icon-192.png.old",
    "/badge-96.pngs",
  ]) {
    assert.equal(matches(url), true, `${url} is protected`);
  }
});
