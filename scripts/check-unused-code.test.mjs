import assert from "node:assert/strict";
import test from "node:test";
import { checkUnusedCode, collectFindings } from "./check-unused-code.mjs";

const FILE = "packages/junior/src/feature.ts";

test("collects unused files, exports, and types from the knip report", () => {
  const findings = collectFindings({
    issues: [
      {
        file: FILE,
        files: [],
        exports: [{ name: "zeta" }, { name: "alpha" }],
        types: [{ name: "Shape" }],
      },
      {
        file: "packages/junior/src/dead.ts",
        files: [{ name: "packages/junior/src/dead.ts" }],
        exports: [],
        types: [],
      },
    ],
  });
  assert.deepEqual(findings, {
    files: ["packages/junior/src/dead.ts"],
    exports: [`${FILE}: alpha`, `${FILE}: zeta`],
    types: [`${FILE}: Shape`],
  });
});

test("passes when findings match the baseline", () => {
  const findings = { files: [], exports: [`${FILE}: alpha`], types: [] };
  assert.deepEqual(
    checkUnusedCode(findings, { exports: [`${FILE}: alpha`] }),
    [],
  );
});

test("fails on a finding that the baseline does not list", () => {
  const errors = checkUnusedCode(
    { files: [], exports: [`${FILE}: alpha`], types: [] },
    {},
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /feature\.ts: alpha: unused export/);
});

test("fails on a baseline entry that is no longer unused", () => {
  const errors = checkUnusedCode(
    { files: [], exports: [], types: [] },
    { types: [`${FILE}: Shape`] },
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Remove it from "types"/);
});
