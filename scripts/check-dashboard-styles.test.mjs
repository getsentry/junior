import assert from "node:assert/strict";
import test from "node:test";
import {
  findArbitraryTextSizes,
  findDashboardUtilityAssertions,
  findNonstandardNeutralTextColors,
  findUndersizedHardcodedFontSizes,
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

test("reports absolute arbitrary text sizes and allows relative em", () => {
  assert.deepEqual(
    findArbitraryTextSizes([
      {
        path: "src/example.tsx",
        contents: [
          'const tooSmall = "font-mono text-[0.54rem] uppercase";',
          'const responsive = "sm:text-[12px] text-dashboard-text";',
          'const allowedNamed = "text-xs text-sm text-base";',
          'const allowedRelative = "font-mono text-[0.9em] text-cyan-50";',
          'const allowedHeading = props.level <= 2 ? "text-[1.05em]" : "text-[1em]";',
        ].join("\n"),
      },
    ]),
    [
      'src/example.tsx:1: const tooSmall = "font-mono text-[0.54rem] uppercase";',
      'src/example.tsx:2: const responsive = "sm:text-[12px] text-dashboard-text";',
    ],
  );
});

test("reports hardcoded font sizes below the 13px floor", () => {
  assert.deepEqual(
    findUndersizedHardcodedFontSizes([
      {
        path: "src/chart.tsx",
        contents: [
          '<text fontSize="9">axis</text>',
          '<text fontSize="12">still small</text>',
          '<text fontSize="13">floor</text>',
          '<text fontSize="14">ok</text>',
        ].join("\n"),
      },
    ]),
    [
      'src/chart.tsx:1: <text fontSize="9">axis</text>',
      'src/chart.tsx:2: <text fontSize="12">still small</text>',
    ],
  );
});
