import assert from "node:assert/strict";
import test from "node:test";
import { checkPathCase } from "./check-path-case.mjs";

test("reports names that differ only in case", () => {
  const [error, ...rest] = checkPathCase([
    "src/components/PeoplePicker.tsx",
    "src/components/peoplePicker.ts",
  ]);
  assert.deepEqual(rest, []);
  assert.match(error, /differs only in case/);
});

test("allows one name with several extensions and different names", () => {
  assert.deepEqual(
    checkPathCase([
      "src/a/Button.tsx",
      "src/a/Button.css",
      "src/a/Button.test.tsx",
      "src/b/button.tsx",
      "src/a/peoplePickerOptions.ts",
      "AGENTS.md",
      "agents.toml",
    ]),
    [],
  );
});
