import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkAwaitInLoop,
  countAwaitInLoop,
  readOverrideFiles,
} from "./check-await-in-loop.mjs";

const FILE = "packages/junior/src/feature.ts";

function countIn(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "await-in-loop-test-"));
  try {
    for (const [filePath, contents] of Object.entries(files)) {
      fs.mkdirSync(path.join(root, path.dirname(filePath)), {
        recursive: true,
      });
      fs.writeFileSync(path.join(root, filePath), contents);
    }
    return countAwaitInLoop(root, Object.keys(files));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("counts awaits in loops and honors disable comments", () => {
  const counts = countIn({
    [FILE]: [
      "export async function run(ids, read) {",
      "  for (const id of ids) await read(id);",
      "  while (ids.length) await read(ids.pop());",
      "  // oxlint-disable-next-line no-await-in-loop -- Each page needs the cursor.",
      "  for (const id of ids) await read(id);",
      "  await Promise.all(ids.map((id) => read(id)));",
      "}",
    ].join("\n"),
    "packages/junior/src/clean.ts": "export const value = 1;\n",
  });
  assert.deepEqual(counts, { [FILE]: 2 });
});

test("rejects a baselined file that gains a site", () => {
  const [error] = checkAwaitInLoop({
    baseline: { [FILE]: 1 },
    counts: { [FILE]: 2 },
    overrideFiles: [FILE],
  });
  assert.match(
    error,
    /^packages\/junior\/src\/feature\.ts: no-await-in-loop: 2 found, baseline allows 1\. .*p-limit.*policies\/performance\.md/,
  );
});

test("asks to lower or remove an entry after a fix", () => {
  assert.deepEqual(
    checkAwaitInLoop({
      baseline: { [FILE]: 3, "packages/junior/src/fixed.ts": 1 },
      counts: { [FILE]: 2 },
      overrideFiles: [FILE, "packages/junior/src/fixed.ts"],
    }),
    [
      `${FILE}: no-await-in-loop: 2 found, baseline allows 3. Lower the entry in scripts/await-in-loop-baseline.json to 2.`,
      "packages/junior/src/fixed.ts: no-await-in-loop: 0 found, baseline allows 1. Remove the entry from scripts/await-in-loop-baseline.json and from tools/oxlint/await-in-loop.json.",
    ],
  );
});

test("rejects an override file list that differs from the baseline", () => {
  const errors = checkAwaitInLoop({
    baseline: { [FILE]: 1 },
    counts: { [FILE]: 1 },
    overrideFiles: ["packages/junior/src/new.ts"],
  });
  assert.equal(errors.length, 2);
  assert.match(
    errors[0],
    /feature\.ts: in scripts\/await-in-loop-baseline\.json but not in/,
  );
  assert.match(
    errors[1],
    /new\.ts: in tools\/oxlint\/await-in-loop\.json but not in .*Do not add files/,
  );
});

test("reads only the overrides that turn the rule off", () => {
  assert.deepEqual(
    readOverrideFiles({
      overrides: [
        {
          files: ["packages/*/src/**"],
          rules: { "no-await-in-loop": "error" },
        },
        { files: [FILE], rules: { "no-await-in-loop": "off" } },
      ],
    }),
    [FILE],
  );
});
