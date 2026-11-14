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
