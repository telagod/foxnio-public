import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { POST } = await jiti.import("../app/api/web-auth/session/route.ts");
const { hashPassword } = await jiti.import("./web-password-hash.ts");
const { pinWebAuthSecretForTests } = await jiti.import("./web-auth-secret.ts");

const PASSWORD = "correct horse battery staple";
// Cost 2^12 keeps the suite fast; the route code path is the same.
const PASSWORD_HASH = hashPassword(PASSWORD, { logN: 12 });

let clientCounter = 0;
/** Each test gets its own client address: the sign-in throttle is process-wide. */
function newClient() {
  clientCounter += 1;
  return `203.0.113.${clientCounter}`;
}

function signIn(body, client, { raw = false } = {}) {
  return POST(new Request("http://localhost:30177/api/web-auth/session", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": client },
    body: raw ? body : JSON.stringify(body),
  }));
}

async function withPassword(hash, run) {
  const previous = process.env.OMP_WEB_PASSWORD_HASH;
  if (hash === undefined) delete process.env.OMP_WEB_PASSWORD_HASH;
  else process.env.OMP_WEB_PASSWORD_HASH = hash;
  pinWebAuthSecretForTests({ salt: "a".repeat(43), key: "b".repeat(43) });
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.OMP_WEB_PASSWORD_HASH;
    else process.env.OMP_WEB_PASSWORD_HASH = previous;
    pinWebAuthSecretForTests();
  }
}

test("signs in with the right password and sets an httpOnly session cookie", async () => {
  await withPassword(PASSWORD_HASH, async () => {
    const response = await signIn({ password: PASSWORD }, newClient());
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie") ?? "";
    assert.match(cookie, /^omp_web_session=v1\./);
    assert.match(cookie, /HttpOnly/i);
  });
});

test("rejects a wrong or non-string password with 401", async () => {
  await withPassword(PASSWORD_HASH, async () => {
    const client = newClient();
    for (const body of [{ password: "wrong" }, { password: "" }, {}, { password: 42 }, { password: null }]) {
      const response = await signIn(body, client);
      assert.equal(response.status, 401, JSON.stringify(body));
      assert.equal(response.headers.get("set-cookie"), null);
    }
  });
});

test("a body that is not a JSON object is a 400, not a server error", async () => {
  await withPassword(PASSWORD_HASH, async () => {
    const client = newClient();
    for (const raw of ["null", "42", "true", '"password"', "[]", '["x"]', "{broken", ""]) {
      const response = await signIn(raw, client, { raw: true });
      assert.equal(response.status, 400, raw);
    }
  });
});

test("answers 404 when password protection is not configured", async () => {
  await withPassword(undefined, async () => {
    assert.equal((await signIn({ password: "x" }, newClient())).status, 404);
  });
});

test("locks a client out after repeated failures, with Retry-After, even for the right password", async () => {
  await withPassword(PASSWORD_HASH, async () => {
    const client = newClient();
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await signIn({ password: `wrong-${i}` }, client)).status, 401);
    }
    const locked = await signIn({ password: PASSWORD }, client);
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get("retry-after")) >= 1);
    assert.equal(locked.headers.get("set-cookie"), null);

    // Another client is unaffected by that lock.
    assert.equal((await signIn({ password: PASSWORD }, newClient())).status, 200);
  });
});

test("a successful sign-in resets the failure count", async () => {
  await withPassword(PASSWORD_HASH, async () => {
    const client = newClient();
    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i < 4; i += 1) assert.equal((await signIn({ password: "wrong" }, client)).status, 401);
      assert.equal((await signIn({ password: PASSWORD }, client)).status, 200);
    }
  });
});

test("limits concurrent password verifications and refuses the excess with 429", async () => {
  // A slow hash keeps the first verifications running while the rest arrive.
  await withPassword(hashPassword(PASSWORD, { logN: 15 }), async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => signIn({ password: "wrong" }, newClient())),
    );
    const statuses = responses.map((response) => response.status);
    assert.ok(statuses.includes(429), `expected some 429 in ${statuses}`);
    assert.ok(statuses.includes(401), `expected some verified attempts in ${statuses}`);
    assert.ok(statuses.every((status) => status === 401 || status === 429), statuses.join());
    for (const response of responses.filter((r) => r.status === 429)) {
      assert.ok(Number(response.headers.get("retry-after")) >= 1);
    }
  });
});
