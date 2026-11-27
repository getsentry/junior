import assert from "node:assert/strict";
import test from "node:test";
import { findGrowth, parseBaseline } from "./check-baseline-growth.mjs";

const growth = async (filePath, base, head) =>
  findGrowth(
    await parseBaseline(filePath, base),
    await parseBaseline(filePath, head),
  );

const CHILD = "packages/junior/src/chat/child-agents/child-message.ts";
const STORE = "packages/junior/src/chat/child-agents/store.ts";

// getsentry/junior#3226 added a file and raised a count to pass the check.
test("fails when a rule allows more violations than at the base", async () => {
  assert.deepEqual(
    await growth(
      "scripts/test-architecture-baseline.json",
      JSON.stringify({ "kind-behavior": { [STORE]: 1 } }),
      JSON.stringify({ "kind-behavior": { [CHILD]: 4, [STORE]: 2 } }),
    ),
    [{ rule: "kind-behavior", allowed: 1, count: 6, entries: [CHILD, STORE] }],
  );
});

// getsentry/junior#3460 listed a new e2e spec instead of typechecking it.
test("fails when a list baseline gains a file", async () => {
  const spec = "packages/junior-dashboard/e2e/inbox-tab-count.spec.ts";
  const [result] = await growth(
    "scripts/typecheck-coverage-baseline.json",
    JSON.stringify(["packages/junior-dashboard/e2e/harness.ts"]),
    JSON.stringify(["packages/junior-dashboard/e2e/harness.ts", spec]),
  );
  assert.deepEqual(result.entries, [spec]);
});

test("passes when a file moves or splits with the same total", async () => {
  assert.deepEqual(
    await growth(
      "scripts/type-assertions-baseline.json",
      JSON.stringify({ "packages/junior/src/a.ts": 3 }),
      JSON.stringify({
        "packages/junior/src/a/read.ts": 1,
        "packages/junior/src/a/write.ts": 2,
      }),
    ),
    [],
  );
});

test("passes when a rule is new or a rule keeps no entries", async () => {
  const base = JSON.stringify({ "model-fakes": {} });
  assert.deepEqual(
    await growth(
      "scripts/test-architecture-baseline.json",
      base,
      JSON.stringify({ "model-fakes": {}, "new-rule": { [STORE]: 2 } }),
    ),
    [],
  );
  assert.equal(
    (
      await growth(
        "scripts/test-architecture-baseline.json",
        base,
        JSON.stringify({ "model-fakes": { [STORE]: 1 } }),
      )
    ).length,
    1,
  );
});

test("reads text and module baselines", async () => {
  const line = "packages/junior/src/tool.ts\ttool-description-length\tRun…";
  assert.equal(
    (
      await growth(
        "packages/junior/scripts/tool-descriptions-baseline.txt",
        "# header\n",
        `# header\n${line}\n`,
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await growth(
        "scripts/file-length-exceptions.mjs",
        "export const fileLengthExceptions = {};",
        'export const fileLengthExceptions = { "a.ts": "Long." };',
      )
    ).length,
    1,
  );
});

test("fails when an ast-grep baseline rule ignores another file", async () => {
  const rule = (ignores) =>
    `id: core-import-baseline-history\nignores:\n${ignores.map((file) => `  - ${file}\n`).join("")}`;
  const filePath = "ast-grep/rules/core-import-baseline.yml";
  assert.deepEqual(await growth(filePath, rule([CHILD]), rule([STORE])), []);
  assert.deepEqual(
    await growth(filePath, rule([CHILD]), rule([CHILD, STORE])),
    [
      {
        rule: "core-import-baseline-history",
        allowed: 1,
        count: 2,
        entries: [STORE],
      },
    ],
  );
});
