import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { preferMapBoundedRule } from "./prefer-map-bounded.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const preferMapBounded = [{ messageId: "preferMapBounded" }];

new RuleTester().run("prefer-map-bounded", preferMapBoundedRule, {
  valid: [
    `import { mapBounded } from "@/chat/fan-out";
    await mapBounded(ids, (id) => read(id));`,
    `import pLimit from "p-limit";
    await pLimit(4).map(ids, (id) => read(id));`,
    // One limiter that several lists share keeps one cap for all of them.
    `import pLimit from "p-limit";
    const limit = pLimit(8);
    await Promise.all([
      ...files.map((file) => limit(() => readFile(file))),
      ...dirs.map((dir) => limit(() => readDir(dir))),
    ]);`,
    // allSettled keeps every result, and mapBounded rejects on the first error.
    `import pLimit from "p-limit";
    const limit = pLimit(8);
    await Promise.allSettled(clients.map((client) => limit(() => client.close())));`,
    // The limiter bounds only one step of a larger callback.
    `import pLimit from "p-limit";
    const limit = pLimit(8);
    await Promise.all(rows.map(async (row) => ({ row, ok: await limit(() => check(row)) })));`,
    // A limiter that is not from p-limit is out of scope.
    `const limit = makeLimit(8);
    await Promise.all(ids.map((id) => limit(() => read(id))));`,
  ],
  invalid: [
    {
      code: `import pLimit from "p-limit";
      const limit = pLimit(FAN_OUT_CONCURRENCY);
      await Promise.all(ids.map((id) => limit(() => read(id))));`,
      errors: preferMapBounded,
    },
    {
      code: `import pLimit from "p-limit";
      const limit = pLimit(4);
      const rows = await Promise.all(ids.map((id) => { return limit(async () => read(id)); }));`,
      errors: preferMapBounded,
    },
    {
      code: `import makeLimit from "p-limit";
      await Promise.all(ids.map((id) => makeLimit(4)(() => read(id))));`,
      errors: preferMapBounded,
    },
  ],
});
