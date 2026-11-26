import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkProcessEnvReads,
  countProcessEnvReads,
  isCheckedFile,
} from "./check-process-env.mjs";

const FILE = "packages/junior/src/chat/feature.ts";

function countIn(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "process-env-"));
  try {
    for (const [filePath, contents] of Object.entries(files)) {
      fs.mkdirSync(path.join(root, path.dirname(filePath)), {
        recursive: true,
      });
      fs.writeFileSync(path.join(root, filePath), contents);
    }
    return countProcessEnvReads(root, ["packages"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("counts every form of process.env access with the parser", () => {
  const counts = countIn({
    [FILE]: [
      "const a = process.env.AI_MODEL;",
      'const b = process.env["AI_MODEL"];',
      "const { AI_MODEL } = process.env;",
      "readConfig(process.env);",
      "// process.env.AI_MODEL",
      'const c = "process.env.AI_MODEL";',
      "const d = env.AI_MODEL;",
    ].join("\n"),
  });
  assert.deepEqual(counts, { [FILE]: 4 });
});

test("rejects a file that gains a read", () => {
  const [error] = checkProcessEnvReads({ [FILE]: 1 }, {});
  assert.match(
    error,
    /^packages\/junior\/src\/chat\/feature\.ts: process\.env reads: 1 found, baseline allows 0\. Read env only in src\/config\.ts, through loadConfig, or in an entrypoint/,
  );
  assert.equal(checkProcessEnvReads({ [FILE]: 3 }, { [FILE]: 2 }).length, 1);
});

test("accepts a count equal to the baseline", () => {
  assert.deepEqual(checkProcessEnvReads({ [FILE]: 2 }, { [FILE]: 2 }), []);
  assert.deepEqual(checkProcessEnvReads({}, {}), []);
});

test("requires a lower baseline entry when the count goes down", () => {
  assert.deepEqual(checkProcessEnvReads({ [FILE]: 1 }, { [FILE]: 2 }), [
    `${FILE}: process.env reads: 1 found, baseline allows 2. Lower the entry in scripts/process-env-baseline.json to 1.`,
  ]);
  assert.deepEqual(checkProcessEnvReads({}, { [FILE]: 1 }), [
    `${FILE}: process.env reads: 0 found, baseline allows 1. Remove the entry from scripts/process-env-baseline.json.`,
  ]);
});

test("allows the config layer and entrypoints", () => {
  assert.equal(isCheckedFile("packages/junior/src/chat/secrets.ts"), true);
  assert.equal(isCheckedFile("packages/junior/src/app.ts"), true);
  for (const filePath of [
    "packages/junior/src/config.ts",
    "packages/junior/src/cli/chat.ts",
    "packages/junior/src/instrumentation.ts",
    "packages/junior/src/nitro.ts",
    "packages/junior/src/build/dev-queue.ts",
    "packages/junior/src/env/files.ts",
    "packages/junior/tests/unit/app.test.ts",
    "packages/junior-github/src/index.ts",
  ]) {
    assert.equal(isCheckedFile(filePath), false, filePath);
  }
});
