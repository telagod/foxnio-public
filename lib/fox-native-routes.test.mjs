import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
for (const [path, methods] of [
  ["state", ["GET"]], ["preferences", ["GET", "POST", "DELETE"]],
  ["projects", ["PATCH"]], ["tickets/[id]", ["PATCH"]], ["approvals/[id]", ["POST"]],
]) {
  test(`legacy ${path} cannot read, mutate or execute the old control plane`, async () => {
    const route = await jiti.import(`../app/api/chief/${path}/route.ts`);
    for (const method of methods) {
      const response = await route[method]();
      assert.equal(response.status, 410);
      assert.equal((await response.json()).code, "fox_native_only");
    }
  });
}
