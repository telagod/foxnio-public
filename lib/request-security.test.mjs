import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./request-security.ts");
}

test("allows same-origin and non-browser API requests", async () => {
  const { isApiRequestOriginAllowed } = await loadSubject();
  assert.equal(isApiRequestOriginAllowed(new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: { origin: "http://localhost:30141", "sec-fetch-site": "same-origin" },
  })), true);
  assert.equal(isApiRequestOriginAllowed(new Request("http://localhost:30141/api/test", { method: "POST" })), true);
});

test("allows LAN same-origin requests when Next.js uses an internal localhost URL", async () => {
  const { isApiRequestOriginAllowed } = await loadSubject();
  const request = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "192.168.32.7:30141",
      origin: "http://192.168.32.7:30141",
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(isApiRequestOriginAllowed(request), true);
});

test("allows a matching Origin even when Sec-Fetch-Site is cross-site", async () => {
  const { isApiRequestOriginAllowed } = await loadSubject();
  assert.equal(isApiRequestOriginAllowed(new Request("http://localhost:30141/api/test", {
    headers: { origin: "http://localhost:30141", "sec-fetch-site": "cross-site" },
  })), true);
});

test("rejects same-host default-port origins for a non-default-port server", async () => {
  const { isApiRequestOriginAllowed } = await loadSubject();
  for (const origin of ["http://127.0.0.1", "http://127.0.0.1:80"]) {
    const request = new Request("http://localhost:30141/api/test", {
      method: "POST",
      headers: { host: "127.0.0.1:30177", origin, "sec-fetch-site": "same-origin" },
    });
    assert.equal(isApiRequestOriginAllowed(request), false, origin);
  }
});

test("compares complete normalized origins including scheme and port", async () => {
  const { isApiRequestOriginAllowed } = await loadSubject();
  for (const [url, origin, allowed] of [
    ["http://localhost/api/test", "http://LOCALHOST:80", true],
    ["https://localhost/api/test", "https://LOCALHOST:443", true],
    ["https://localhost:30177/api/test", "https://localhost", false],
    ["https://localhost/api/test", "http://localhost", false],
    ["http://localhost/api/test", "null", false],
  ]) {
    assert.equal(isApiRequestOriginAllowed(new Request(url, { headers: { origin } })), allowed, origin);
  }
});

test("rejects a same-host origin on a different explicit port", async () => {
  const { isApiRequestOriginAllowed } = await loadSubject();
  const otherPort = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: { host: "127.0.0.1:30177", origin: "http://127.0.0.1:9999", "sec-fetch-site": "cross-site" },
  });
  assert.equal(isApiRequestOriginAllowed(otherPort), false);
});

test("rejects cross-origin browser API requests", async () => {
  const { isApiRequestOriginAllowed, shouldCheckApiRequestOrigin } = await loadSubject();
  const post = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
  });
  const crossSiteGet = new Request("http://localhost:30141/api/sessions", {
    headers: { "sec-fetch-site": "cross-site" },
  });
  assert.equal(shouldCheckApiRequestOrigin(post), true);
  assert.equal(isApiRequestOriginAllowed(post), false);
  assert.equal(shouldCheckApiRequestOrigin(crossSiteGet), true);
  assert.equal(isApiRequestOriginAllowed(crossSiteGet), false);
});

test("rejects an origin that does not match the external request host", async () => {
  const { isApiRequestOriginAllowed } = await loadSubject();
  const request = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "192.168.32.7:30141",
      origin: "http://attacker.example",
      "sec-fetch-site": "same-site",
    },
  });
  assert.equal(isApiRequestOriginAllowed(request), false);
});

test("isHostAllowed accepts only loopback names and addresses by default", async () => {
  const { isHostAllowed } = await loadSubject();
  const cases = [
    // [Host header, allowed]
    ["localhost", true],
    ["localhost:30177", true],
    ["LOCALHOST:30177", true],
    ["localhost.", true],
    ["app.localhost:30177", true],
    ["a.b.localhost", true],
    ["127.0.0.1", true],
    ["127.0.0.1:30177", true],
    ["127.1.2.3:80", true],
    ["127.255.255.254", true],
    ["[::1]", true],
    ["[::1]:30177", true],
    ["[0:0:0:0:0:0:0:1]:30177", true],
    ["localhost.evil.com", false],
    ["evil.localhost.com", false],
    ["notlocalhost", false],
    ["127.example.com", false],
    ["127.0.0.1.evil.com", false],
    ["127.0.0.1.evil.com:30177", false],
    ["127.0.0", false],
    ["127.0.0.256", false],
    ["127.0.0.1.", true],
    ["0.0.0.0", false],
    ["10.0.0.5:30177", false],
    ["192.168.1.20", false],
    ["attacker.example:30177", false],
    ["[::2]", false],
    ["[::ffff:10.0.0.1]", false],
    ["::1", false],
    ["user@localhost", false],
    ["localhost@evil.com", false],
    ["localhost/", false],
    ["localhost:abc", false],
    ["localhost:123456", false],
    ["local host", false],
    ["", false],
    [" ", false],
    [".", false],
    [null, false],
    [undefined, false],
  ];
  for (const [host, expected] of cases) {
    assert.equal(isHostAllowed(host, {}), expected, `Host ${JSON.stringify(host)}`);
  }
});

test("isHostAllowed honours OMP_WEB_ALLOWED_HOSTS entries and wildcards", async () => {
  const { isHostAllowed } = await loadSubject();
  const env = { OMP_WEB_ALLOWED_HOSTS: " Foxnio.Example.com , nas:8443,*.tailnet.ts.net,[fd00::1],,bad host,*" };
  const cases = [
    ["foxnio.example.com", true],
    ["FOXNIO.example.com:30177", true],
    ["foxnio.example.com.", true],
    ["other.example.com", false],
    ["foxnio.example.com.evil.com", false],
    ["nas", true],
    // The port in an entry does not restrict the port of the request.
    ["nas:1234", true],
    ["box.tailnet.ts.net", true],
    ["a.b.tailnet.ts.net:30177", true],
    // A wildcard covers subdomains only, and only on a label boundary.
    ["tailnet.ts.net", false],
    ["eviltailnet.ts.net", false],
    ["[fd00::1]:30177", true],
    ["[fd00::2]", false],
    // Malformed entries (and a bare "*") grant nothing.
    ["bad", false],
    ["anything.example", false],
    ["localhost", true],
  ];
  for (const [host, expected] of cases) {
    assert.equal(isHostAllowed(host, env), expected, `Host ${JSON.stringify(host)}`);
  }
  assert.equal(isHostAllowed("foxnio.example.com", { OMP_WEB_ALLOWED_HOSTS: "" }), false);
});

test("isRequestHostAllowed reads the Host header and falls back to the request URL", async () => {
  const { isRequestHostAllowed } = await loadSubject();
  // The URL may be Next's internal localhost one; the Host header is what the client addressed.
  assert.equal(isRequestHostAllowed(new Request("http://localhost:30177/", { headers: { host: "attacker.example:30177" } }), {}), false);
  assert.equal(isRequestHostAllowed(new Request("http://attacker.example/", { headers: { host: "127.0.0.1:30177" } }), {}), true);
  assert.equal(isRequestHostAllowed(new Request("http://localhost:30177/api/x"), {}), true);
  assert.equal(isRequestHostAllowed(new Request("http://attacker.example:30177/api/x"), {}), false);
  assert.equal(isRequestHostAllowed(new Request("http://attacker.example:30177/api/x"), { OMP_WEB_ALLOWED_HOSTS: "attacker.example" }), true);
});
