import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { boundedFanOutRule } from "./bounded-fan-out.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const unbounded = [{ messageId: "unbounded" }];

new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
}).run("bounded-fan-out", boundedFanOutRule, {
  valid: [
    `import pLimit from "p-limit";
    const limit = pLimit(8);
    await Promise.all(ids.map((id) => limit(() => read(id))));`,
    `import pLimit from "p-limit";
    const limit = pLimit(8);
    await Promise.all(ids.map(async (id) => (await limit(() => read(id))) ?? fallback));`,
    // A local work function that runs through the limiter is bounded.
    `import pLimit from "p-limit";
    const limit = pLimit(8);
    const read = (id) => limit(() => load(id));
    await Promise.all(ids.map(read));`,
    // The callback starts no async work of its own.
    "await Promise.all(pending.map((entry) => entry.promise));",
    "const rows = ids.map(async (id) => read(id));",
    // A literal list has a fixed size.
    "await Promise.all([a, b].map(async (id) => read(id)));",
    "await Promise.all(([a, b] as const).map((id) => read(id)));",
    `const ids = [a, b] as const;
    await Promise.all(ids.map(read));`,
    `const ids = [a, b] satisfies [string, string];
    await Promise.all(ids.map(read));`,
    // A tuple type fixes the length, and the compiler checks it.
    `const ids: readonly [string, string] = actorIds(user);
    await Promise.all(ids.map((id) => read(id)));`,
    `async function run(ids: [string, string, string]) {
      await Promise.all(ids.map((id) => read(id)));
    }`,
    // A constant caps the slice.
    `const MAX = 3;
    const first = items.slice(0, MAX);
    await Promise.all(first.map((item) => read(item)));`,
    "await Promise.all(items.slice(0, 3).map((item) => read(item)));",
    "await Promise.all(Array.from({ length: 3 }, () => read()));",
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
      // A sync callback that returns a call.
      code: "await Promise.all(ids.map((id) => read(id)));",
      errors: unbounded,
    },
    {
      code: "await Promise.all(ids.map((id) => { return read(id); }));",
      errors: unbounded,
    },
    {
      // A function reference.
      code: "await Promise.all(ids.map(read));",
      errors: unbounded,
    },
    {
      code: "await Promise.all(ids.map(store.read));",
      errors: unbounded,
    },
    {
      code: "await Promise.all(ids.flatMap((id) => [read(id), write(id)]));",
      errors: unbounded,
    },
    {
      code: "await Promise.all(ids.flatMap(async (id) => read(id)));",
      errors: unbounded,
    },
    {
      code: "await Promise.all(Array.from(ids, (id) => read(id)));",
      errors: unbounded,
    },
    {
      code: "await Promise.all(Array.from({ length: count }, () => read()));",
      errors: unbounded,
    },
    {
      // Promises mapped into a const first.
      code: `const reads = ids.map(async (id) => read(id));
      await Promise.all(reads);`,
      errors: unbounded,
    },
    {
      code: "await Promise.all([...ids].map(async (id) => read(id)));",
      errors: unbounded,
    },
    {
      // A plain array literal in a binding can grow before the map.
      code: `const ids = [a];
      ids.push(...more);
      await Promise.all(ids.map((id) => read(id)));`,
      errors: unbounded,
    },
    {
      // An array type has no fixed length.
      code: `async function run(ids: readonly string[]) {
        await Promise.all(ids.map((id) => read(id)));
      }`,
      errors: unbounded,
    },
    {
      code: "await Promise.all(items.slice(0, count).map((item) => read(item)));",
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
