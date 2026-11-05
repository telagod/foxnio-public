import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@/": new URL("../", import.meta.url).pathname },
});

test("refuses a query that would be read as a CLI option before searching", async (t) => {
  const queries = [];
  const server = http.createServer((req, res) => {
    queries.push(new URL(req.url, "http://localhost").searchParams.get("q"));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ skills: [{ id: "acme/react", name: "react", source: "acme/skills", installs: 1200 }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const previous = process.env.SKILLS_API_URL;
  // The route reads SKILLS_API_URL when it is first imported.
  process.env.SKILLS_API_URL = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    server.close();
    if (previous === undefined) delete process.env.SKILLS_API_URL;
    else process.env.SKILLS_API_URL = previous;
  });
  const { POST } = await jiti.import("../app/api/skills/search/route.ts");
  const post = (query) => POST(new Request("http://localhost/api/skills/search", { method: "POST", body: JSON.stringify({ query }) }));

  for (const query of ["--help", "-g", "  --yes react"]) {
    const response = await post(query);
    assert.equal(response.status, 400, query);
    assert.equal((await response.json()).code, "query_invalid");
  }
  assert.deepEqual(queries, [], "neither the API nor npx is reached");

  const ok = await post("react");
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).results.map((result) => result.package), ["acme/skills@react"]);
  assert.deepEqual(queries, ["react"]);
});
