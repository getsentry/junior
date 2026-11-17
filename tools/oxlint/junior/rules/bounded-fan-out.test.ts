import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { boundedFanOutRule } from "./bounded-fan-out.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const unbounded = [{ messageId: "unbounded" }];

new RuleTester().run("bounded-fan-out", boundedFanOutRule, {
  valid: [
    `import pLimit from "p-limit";
    const limit = pLimit(8);
    await Promise.all(ids.map((id) => limit(() => read(id))));`,
    `import pLimit from "p-limit";
    const limit = pLimit(8);
    await Promise.all(ids.map(async (id) => (await limit(() => read(id))) ?? fallback));`,
    // A literal list has a fixed size.
    "await Promise.all([a, b].map(async (id) => read(id)));",
    // The callback starts no async work of its own.
    "await Promise.all(pending.map((entry) => entry.promise));",
    "const rows = ids.map(async (id) => read(id));",
  ],
  invalid: [
    {
      code: "await Promise.all(ids.map(async (id) => read(id)));",
      errors: unbounded,
    },
    {
      code: "await Promise.allSettled(ids.map(async function (id) { return read(id); }));",
      errors: unbounded,
    },
    {
      code: "await Promise.all([...ids].map(async (id) => read(id)));",
      errors: unbounded,
    },
    {
      // A limiter that is not from p-limit does not bound the work.
      code: `const limit = makeLimit(8);
      await Promise.all(ids.map(async (id) => limit(() => read(id))));`,
      errors: unbounded,
    },
  ],
});
