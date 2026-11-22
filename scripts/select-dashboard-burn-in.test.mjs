import assert from "node:assert/strict";
import test from "node:test";
import { countTests } from "./select-dashboard-burn-in.mjs";

function spec(file, projects) {
  return { file, tests: projects.map((projectName) => ({ projectName })) };
}

test("counts each project run of a spec and each file once", () => {
  const report = {
    suites: [
      {
        specs: [spec("memories.spec.ts", ["classic"])],
        suites: [
          {
            specs: [
              spec("memories.spec.ts", ["classic"]),
              spec("code.spec.ts", ["classic", "inbox"]),
            ],
          },
        ],
      },
    ],
  };
  assert.deepEqual(countTests(report), {
    files: ["code.spec.ts", "memories.spec.ts"],
    tests: 4,
  });
});

test("counts nothing when no spec changed", () => {
  assert.deepEqual(countTests({ suites: [] }), { files: [], tests: 0 });
});
