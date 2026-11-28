import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkAstGrepIgnores } from "./check-ast-grep-ignores.mjs";

function writeProject(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ast-grep-ignores-"));
  for (const [name, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), contents);
  }
  return root;
}

const RULE = `id: no-console
language: TypeScript
severity: error
message: No console.
files:
  - src/**/*.ts
ignores:
  - src/owner.ts
  - src/stale/**
rule:
  pattern: console.log($$$)
`;

test("reports an ignore that exempts no finding and keeps a used one", async () => {
  const root = writeProject({
    "ast-grep/rules/no-console.yml": RULE,
    "src/owner.ts": 'console.log("owner");\n',
    "src/stale/clean.ts": "export const clean = 1;\n",
  });

  assert.deepEqual(await checkAstGrepIgnores(root), [
    "ast-grep/rules/no-console.yml: no-console ignores src/stale/**, but it exempts no finding.",
  ]);
});

test("passes when every ignore exempts a finding", async () => {
  const root = writeProject({
    "ast-grep/rules/no-console.yml": RULE,
    "src/owner.ts": 'console.log("owner");\n',
    "src/stale/legacy.ts": 'console.log("legacy");\n',
  });

  assert.deepEqual(await checkAstGrepIgnores(root), []);
});

const COUNTED_RULE = `id: no-console
language: TypeScript
severity: error
message: No console.
files:
  - src/**/*.ts
ignores:
  - src/legacy.ts
  - src/fixed.ts
metadata:
  baseline:
    src/legacy.ts: 2
    src/fixed.ts: 1
rule:
  pattern: console.log($$$)
`;

test("checks the finding count of each file in a rule baseline", async () => {
  const project = (legacy) =>
    writeProject({
      "ast-grep/rules/no-console-baseline.yml": COUNTED_RULE,
      "src/legacy.ts": 'console.log("legacy");\n'.repeat(legacy),
      "src/fixed.ts": "export const fixed = 1;\n",
    });

  assert.deepEqual(await checkAstGrepIgnores(project(3)), [
    "src/legacy.ts: no-console finds 3, but its baseline in ast-grep/rules/no-console-baseline.yml is 2. Fix the new finding. The baseline can only go down.",
    "ast-grep/rules/no-console-baseline.yml: no-console ignores src/fixed.ts, but it exempts no finding.",
  ]);
  assert.deepEqual(await checkAstGrepIgnores(project(1)), [
    "src/legacy.ts: no-console finds 1, but its baseline in ast-grep/rules/no-console-baseline.yml is 2. Lower the entry to 1.",
    "ast-grep/rules/no-console-baseline.yml: no-console ignores src/fixed.ts, but it exempts no finding.",
  ]);
});
