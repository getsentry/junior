import assert from "node:assert/strict";
import test from "node:test";
import {
  findDashboardUtilityAssertions,
  findNonstandardNeutralTextColors,
} from "./check-dashboard-styles.mjs";

test("reports one-off neutral text colors", () => {
  assert.deepEqual(
    findNonstandardNeutralTextColors([
      {
        path: "src/example.tsx",
        contents: [
          'const legacy = "text-white/80";',
          'const oldToken = "text-dashboard-text-secondary";',
          'const arbitrary = "text-[#aaa]";',
          'const allowed = "text-[#ff0000] text-dashboard-text-muted";',
        ].join("\n"),
      },
    ]),
    [
      'src/example.tsx:1: const legacy = "text-white/80";',
      'src/example.tsx:2: const oldToken = "text-dashboard-text-secondary";',
      'src/example.tsx:3: const arbitrary = "text-[#aaa]";',
    ],
  );
});

test("reports assertions against CSS utility strings", () => {
  assert.deepEqual(
    findDashboardUtilityAssertions([
      {
        path: "tests/example.test.tsx",
        contents: [
          'expect(html).toContain("grid-cols-2");',
          'expect(html).not.toMatch("lg:flex-row");',
          'expect(html).toContain("visible product text");',
        ].join("\n"),
      },
    ]),
    [
      'tests/example.test.tsx:1: expect(html).toContain("grid-cols-2");',
      'tests/example.test.tsx:2: expect(html).not.toMatch("lg:flex-row");',
    ],
  );
});
