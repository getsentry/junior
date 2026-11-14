import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkTypeAssertions,
  countTypeAssertions,
  isCheckedFile,
} from "./check-type-assertions.mjs";

const FILE = "packages/junior/src/feature.ts";

function countIn(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "type-assertions-"));
  try {
    for (const [filePath, contents] of Object.entries(files)) {
      fs.mkdirSync(path.join(root, path.dirname(filePath)), {
        recursive: true,
      });
      fs.writeFileSync(path.join(root, filePath), contents);
    }
    return countTypeAssertions(root, ["packages"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("counts `as` and angle-bracket assertions with the parser", () => {
  const counts = countIn({
    [FILE]: [
      "const a = value as Item;",
      "const b = <Item>value;",
      "const c = value as unknown as Item;",
      "const d = (value as { id: string }).id;",
      "const e = [1, 2] as const;",
      "const f = { id: 1 } satisfies Item;",
      'import { item as alias } from "./item";',
      "type Keys = { [K in keyof Item as `x${K}`]: K };",
      "// value as Item",
      'const g = "value as Item";',
    ].join("\n"),
    "packages/junior/src/view.tsx": [
      "const a = <div>{(value as Item).id}</div>;",
      "const b = value as const;",
    ].join("\n"),
  });
  assert.deepEqual(counts, {
    [FILE]: 5,
    "packages/junior/src/view.tsx": 1,
  });
});

test("rejects a file that gains an assertion", () => {
  const counts = countIn({ [FILE]: "const a = value as Item;" });
  const [error] = checkTypeAssertions(counts, {});
  assert.match(
    error,
    /^packages\/junior\/src\/feature\.ts: type assertions: 1 found, baseline allows 0\. .*zod schema.*policies\/runtime-boundary-schemas\.md/,
  );
  assert.equal(checkTypeAssertions({ [FILE]: 3 }, { [FILE]: 2 }).length, 1);
});

test("accepts a count equal to the baseline", () => {
  assert.deepEqual(checkTypeAssertions({ [FILE]: 2 }, { [FILE]: 2 }), []);
  assert.deepEqual(checkTypeAssertions({}, {}), []);
});

test("requires a lower baseline entry when the count goes down", () => {
  assert.deepEqual(checkTypeAssertions({ [FILE]: 1 }, { [FILE]: 2 }), [
    `${FILE}: type assertions: 1 found, baseline allows 2. Lower the entry in scripts/type-assertions-baseline.json to 1.`,
  ]);
  assert.deepEqual(checkTypeAssertions({}, { [FILE]: 1 }), [
    `${FILE}: type assertions: 0 found, baseline allows 1. Remove the entry from scripts/type-assertions-baseline.json.`,
  ]);
});

test("checks production source only", () => {
  assert.equal(isCheckedFile("packages/junior/src/chat/app.ts"), true);
  assert.equal(isCheckedFile("packages/junior-github/src/index.ts"), true);
  for (const filePath of [
    "packages/junior/src/chat/app.test.ts",
    "packages/junior-dashboard/src/client/view.spec.tsx",
    "packages/junior/src/chat/__tests__/app.ts",
    "packages/junior/src/fixtures/app.ts",
    "packages/junior/tests/integration/app.test.ts",
    "packages/junior-evals/src/fixture/agent.ts",
    "packages/junior-testing/src/postgres.ts",
    "scripts/check-type-assertions.mjs",
  ]) {
    assert.equal(isCheckedFile(filePath), false, filePath);
  }
});
