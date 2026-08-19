import assert from "node:assert/strict";
import test from "node:test";
import {
  findAdditiveSafeAreaPadding,
  findArbitraryTextSizes,
  findClassicViewportHeights,
  findComposerSafeAreaBottomPadding,
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

test("reports hardcoded font sizes below the 12px floor", () => {
  assert.deepEqual(
    findUndersizedHardcodedFontSizes([
      {
        path: "src/chart.tsx",
        contents: [
          '<text fontSize="9">axis</text>',
          '<text fontSize="11">still small</text>',
          '<text fontSize="12">floor</text>',
          '<text fontSize="13">ok</text>',
        ].join("\n"),
      },
    ]),
    [
      'src/chart.tsx:1: <text fontSize="9">axis</text>',
      'src/chart.tsx:2: <text fontSize="11">still small</text>',
    ],
  );
});

test("reports classic 100vh and allows dvh", () => {
  assert.deepEqual(
    findClassicViewportHeights([
      {
        path: "src/shell.tsx",
        contents: [
          'const bad = "min-h-[calc(100vh-5rem)]";',
          'const ok = "h-[100dvh] min-h-[var(--dashboard-viewport-height)]";',
          "// note about 100vh stays a comment",
          "/* fallback: 100vh */",
          '{/* className="h-[100vh]" */}',
          " * JSDoc 100vh continuation",
        ].join("\n"),
      },
    ]),
    ['src/shell.tsx:1: const bad = "min-h-[calc(100vh-5rem)]";'],
  );
});

test("reports additive safe-area padding and allows max()", () => {
  assert.deepEqual(
    findAdditiveSafeAreaPadding([
      {
        path: "src/composer.tsx",
        contents: [
          'const stacked = "pb-[calc(0.375rem+env(safe-area-inset-bottom))]";',
          'const stackedReverse = "pb-[calc(env(safe-area-inset-bottom)+0.375rem)]";',
          'const ok = "pb-[max(0.375rem,env(safe-area-inset-bottom))]";',
        ].join("\n"),
      },
    ]),
    [
      'src/composer.tsx:1: const stacked = "pb-[calc(0.375rem+env(safe-area-inset-bottom))]";',
      'src/composer.tsx:2: const stackedReverse = "pb-[calc(env(safe-area-inset-bottom)+0.375rem)]";',
    ],
  );
});

test("reports composer footers that reintroduce bottom safe-area math", () => {
  assert.deepEqual(
    findComposerSafeAreaBottomPadding([
      {
        path: "src/client/conversations/ConversationPage.tsx",
        contents:
          'const bad = "pb-[max(0.5rem,env(safe-area-inset-bottom))]";',
      },
      {
        path: "src/client/components/Drawer.tsx",
        contents:
          'const okElsewhere = "pb-[max(1rem,env(safe-area-inset-bottom))]";',
      },
    ]),
    [
      'src/client/conversations/ConversationPage.tsx:1: const bad = "pb-[max(0.5rem,env(safe-area-inset-bottom))]";',
    ],
  );
});
