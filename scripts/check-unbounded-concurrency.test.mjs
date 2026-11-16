import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkUnboundedConcurrency,
  countUnboundedConcurrency,
} from "./check-unbounded-concurrency.mjs";

const FILE = "packages/junior/src/feature.ts";

function countIn(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unbounded-"));
  try {
    for (const [filePath, contents] of Object.entries(files)) {
      fs.mkdirSync(path.join(root, path.dirname(filePath)), {
        recursive: true,
      });
      fs.writeFileSync(path.join(root, filePath), contents);
    }
    return countUnboundedConcurrency(root, ["packages"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("counts Promise.all over a mapped list", () => {
  const counts = countIn({
    [FILE]: [
      // getsentry/junior#2921 review: "May wanna pLimit this?"
      "const profiles = await Promise.all(",
      "  missing.map((userId) => lookupSlackUser(teamId, userId)),",
      ");",
      "await Promise.allSettled(ids.map(async (id) => notify(id)));",
      "await Promise.all([...ids].map(load));",
      "await Promise.all(Array.from(ids, load));",
      "await Promise.all([loadA(), loadB()]);",
      "await limit.map(missing, (userId) => lookupSlackUser(teamId, userId));",
      "// Promise.all(ids.map(load))",
      'const text = "Promise.all(ids.map(load))";',
    ].join("\n"),
    "packages/junior/src/view.tsx": "await Promise.all(rows.map(load));",
  });
  assert.deepEqual(counts, {
    [FILE]: 4,
    "packages/junior/src/view.tsx": 1,
  });
});

test("rejects a file that gains an unbounded Promise.all", () => {
  const counts = countIn({ [FILE]: "await Promise.all(ids.map(load));" });
  const [error] = checkUnboundedConcurrency(counts, {});
  assert.match(
    error,
    /^packages\/junior\/src\/feature\.ts: unbounded Promise\.all over a list: 1 found, baseline allows 0\. .*pLimit\(LIMIT\)\.map\(items, fn\)/,
  );
});

test("requires a lower baseline entry when the count goes down", () => {
  assert.deepEqual(checkUnboundedConcurrency({}, { [FILE]: 1 }), [
    `${FILE}: unbounded Promise.all over a list: 0 found, baseline allows 1. Remove the entry from scripts/unbounded-concurrency-baseline.json.`,
  ]);
});
