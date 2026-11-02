import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LEGACY_WHITE_TEXT_PATTERN = /text-white(?:\/\d+)?\b/;
const LEGACY_SECONDARY_TEXT_PATTERN = /text-dashboard-text-secondary/;
const ARBITRARY_TEXT_COLOR_PATTERN = /text-\[#([\da-f]{3}|[\da-f]{6})\]/gi;
// Absolute rem/px/etc sizes bypass the named type scale. Relative em sizes are
// allowed for markdown that scales with its parent.
const ARBITRARY_TEXT_SIZE_PATTERN =
  /(?<![\w-])(?:[a-z]{2,3}:)*text-\[(\d+(?:\.\d+)?)(rem|px|pt|pc|in|cm|mm|q|vh|vw|vmin|vmax|svh|svw|lvh|lvw|dvh|dvw)\]/g;
// SVG/chart tick labels and similar absolute px sizes must stay at the compact 12px floor.
const HARDCODED_FONT_SIZE_PATTERN =
  /\bfontSize\s*=\s*["'`](\d+(?:\.\d+)?)["'`]/g;
const MIN_PRODUCT_FONT_SIZE_PX = 12;
const UTILITY_ASSERTION_PATTERN =
  /\bexpect\(.+\)\.(?:not\.)?(?:toBe|toContain|toEqual|toMatch)\([^)]*["'`](?:[a-z-]+:)*(?:bg|col-span|flex|grid|overflow|row-span|text)-/;
// Classic 100vh follows the large layout viewport on mobile WebKit and can
// leave fixed shells under the browser chrome. Prefer dvh or the dashboard
// viewport CSS variables.
const CLASSIC_VIEWPORT_HEIGHT_PATTERN = /(?<!\w)100vh\b/;
// Stacking padding + safe-area recreates the composer gap. Prefer max().
const ADDITIVE_SAFE_AREA_PATTERN =
  /calc\((?:(?!\)[\s"'`]).)*?(?:\+\s*env\(safe-area-inset-(?:top|right|bottom|left)\)|env\(safe-area-inset-(?:top|right|bottom|left)\)\s*\+)/;
// ComposerDock owns bottom pad through --dashboard-composer-dock-padding.
// Inline env(safe-area-inset-bottom) on dock/footer surfaces reintroduces the gap.
const COMPOSER_SAFE_AREA_BOTTOM_PATTERN = /safe-area-inset-bottom/g;

function hasArbitraryNeutralTextColor(line) {
  return [...line.matchAll(ARBITRARY_TEXT_COLOR_PATTERN)].some((match) => {
    const value = match[1];
    const channels =
      value.length === 3
        ? [...value].map((channel) => `${channel}${channel}`)
        : value.match(/.{2}/g);
    return channels?.every((channel) => channel === channels[0]) ?? false;
  });
}

/** Report dashboard source lines that bypass the shared neutral text colors. */
export function findNonstandardNeutralTextColors(files) {
  return files.flatMap((file) =>
    file.contents.split("\n").flatMap((line, index) => {
      const invalid =
        LEGACY_WHITE_TEXT_PATTERN.test(line) ||
        LEGACY_SECONDARY_TEXT_PATTERN.test(line) ||
        hasArbitraryNeutralTextColor(line);
      return invalid ? [`${file.path}:${index + 1}: ${line.trim()}`] : [];
    }),
  );
}

/** Report absolute arbitrary font sizes that bypass the named type scale. */
export function findArbitraryTextSizes(files) {
  return files.flatMap((file) =>
    file.contents.split("\n").flatMap((line, index) => {
      ARBITRARY_TEXT_SIZE_PATTERN.lastIndex = 0;
      return ARBITRARY_TEXT_SIZE_PATTERN.test(line)
        ? [`${file.path}:${index + 1}: ${line.trim()}`]
        : [];
    }),
  );
}

/** Report hardcoded font sizes below the product UI floor. */
export function findUndersizedHardcodedFontSizes(files) {
  return files.flatMap((file) =>
    file.contents.split("\n").flatMap((line, index) => {
      HARDCODED_FONT_SIZE_PATTERN.lastIndex = 0;
      const matches = [...line.matchAll(HARDCODED_FONT_SIZE_PATTERN)].filter(
        (match) => Number(match[1]) < MIN_PRODUCT_FONT_SIZE_PX,
      );
      return matches.length > 0
        ? [`${file.path}:${index + 1}: ${line.trim()}`]
        : [];
    }),
  );
}

/** Report dashboard tests that freeze CSS utility implementation details. */
export function findDashboardUtilityAssertions(files) {
  return files.flatMap((file) =>
    file.contents
      .split("\n")
      .flatMap((line, index) =>
        UTILITY_ASSERTION_PATTERN.test(line)
          ? [`${file.path}:${index + 1}: ${line.trim()}`]
          : [],
      ),
  );
}

function isCommentOnlyLine(line) {
  const trimmed = line.trimStart();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("{/*")
  );
}

/** Report classic 100vh usage that should prefer dvh on mobile. */
export function findClassicViewportHeights(files) {
  return files.flatMap((file) =>
    file.contents.split("\n").flatMap((line, index) => {
      if (isCommentOnlyLine(line)) return [];
      return CLASSIC_VIEWPORT_HEIGHT_PATTERN.test(line)
        ? [`${file.path}:${index + 1}: ${line.trim()}`]
        : [];
    }),
  );
}

/** Report safe-area padding stacked with + instead of max(). */
export function findAdditiveSafeAreaPadding(files) {
  return files.flatMap((file) =>
    file.contents.split("\n").flatMap((line, index) => {
      ADDITIVE_SAFE_AREA_PATTERN.lastIndex = 0;
      return ADDITIVE_SAFE_AREA_PATTERN.test(line)
        ? [`${file.path}:${index + 1}: ${line.trim()}`]
        : [];
    }),
  );
}

/** Report composer footers that reintroduce bottom safe-area math. */
export function findComposerSafeAreaBottomPadding(files) {
  return files.flatMap((file) => {
    if (
      !/(?:Conversation(?:Page|Workspace|Composer)|ComposerDock|ChatLayout)\.tsx$/.test(
        file.path,
      )
    ) {
      return [];
    }
    return file.contents.split("\n").flatMap((line, index) => {
      if (isCommentOnlyLine(line)) return [];
      COMPOSER_SAFE_AREA_BOTTOM_PATTERN.lastIndex = 0;
      return COMPOSER_SAFE_AREA_BOTTOM_PATTERN.test(line)
        ? [`${file.path}:${index + 1}: ${line.trim()}`]
        : [];
    });
  });
}

// Structural fills, borders, and rings use dashboard tokens, not raw white or
// black opacity steps. Shadows may still use black.
const NEUTRAL_SURFACE_LITERAL_PATTERN =
  /(?<![\w-])(?:[a-z-]+:)*!?(?:bg|border(?:-[xytrblse])?|decoration|divide|fill|outline|ring|stroke)-(?:white|black)(?![\w-])/;
const DASHBOARD_COLOR_UTILITY_PATTERN =
  /(?<![\w-])(?:[a-z-]+:)*!?(?:accent|bg|border|caret|decoration|divide|fill|from|outline|placeholder|ring|shadow|stroke|text|to|via)-dashboard-([a-z]+(?:-[a-z]+)*)/g;

/** Report raw white or black fills, borders, and rings that bypass tokens. */
export function findNeutralSurfaceLiterals(files) {
  return files.flatMap((file) =>
    file.contents
      .split("\n")
      .flatMap((line, index) =>
        NEUTRAL_SURFACE_LITERAL_PATTERN.test(line)
          ? [`${file.path}:${index + 1}: ${line.trim()}`]
          : [],
      ),
  );
}

/** Read the dashboard color token names defined in the Tailwind theme. */
export function dashboardColorTokens(css) {
  return new Set(
    [...css.matchAll(/--color-dashboard-([a-z]+(?:-[a-z]+)*)\s*:/g)].map(
      (match) => match[1],
    ),
  );
}

/** Report dashboard color utilities that name a token the theme does not define. */
export function findUnknownDashboardColorTokens(files, tokens) {
  return files.flatMap((file) =>
    file.contents.split("\n").flatMap((line, index) => {
      const unknown = [...line.matchAll(DASHBOARD_COLOR_UTILITY_PATTERN)]
        .map((match) => match[1])
        .filter((token) => !tokens.has(token));
      return unknown.length > 0
        ? [
            `${file.path}:${index + 1}: unknown dashboard color ${unknown.join(", ")}`,
          ]
        : [];
    }),
  );
}

function collectSourceFiles(root, directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(root, absolutePath, files);
    } else if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)) {
      files.push({
        path: path.relative(root, absolutePath).split(path.sep).join("/"),
        contents: fs.readFileSync(absolutePath, "utf8"),
      });
    }
  }
  return files;
}

function main() {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(scriptDirectory, "..");
  const files = collectSourceFiles(
    root,
    path.join(root, "packages/junior-dashboard/src/client"),
  );
  const testFiles = collectSourceFiles(
    root,
    path.join(root, "packages/junior-dashboard/tests"),
  );
  const tokens = dashboardColorTokens(
    fs.readFileSync(
      path.join(root, "packages/junior-dashboard/src/tailwind.css"),
      "utf8",
    ),
  );
  // Each fix names the design intent so an agent changes the design instead of
  // rewriting the source until the pattern stops matching.
  const checks = [
    {
      fix: "Use a dashboard text token by meaning: text-dashboard-text-solid, text-dashboard-text, text-dashboard-text-subtle, text-dashboard-text-muted, or text-dashboard-text-faint. Do not use text-white, text-dashboard-text-secondary, or gray hex text.",
      lines: findNonstandardNeutralTextColors(files),
    },
    {
      fix: "Use a dashboard surface, fill, overlay, or border token instead of raw white or black. Shadows may use black.",
      lines: findNeutralSurfaceLiterals(files),
    },
    {
      fix: "Use a color token defined in packages/junior-dashboard/src/tailwind.css. Add a new token only when no existing token has this meaning.",
      lines: findUnknownDashboardColorTokens(files, tokens),
    },
    {
      fix: "Use a named type step (text-2xs through text-4xl) chosen by role. Do not use an absolute text-[N] size.",
      lines: findArbitraryTextSizes(files),
    },
    {
      fix: `Keep SVG and chart text at ${MIN_PRODUCT_FONT_SIZE_PX}px or larger. Make room in the layout instead of shrinking the text.`,
      lines: findUndersizedHardcodedFontSizes(files),
    },
    {
      fix: "Use dvh or the visualViewport variables from layout/VisualViewportShell instead of 100vh.",
      lines: findClassicViewportHeights(files),
    },
    {
      fix: "Use max(<padding>, env(safe-area-inset-*)) instead of adding padding to the safe-area inset.",
      lines: findAdditiveSafeAreaPadding(files),
    },
    {
      fix: "conversations/ComposerDock owns the bottom safe-area pad. Remove this safe-area math and let ComposerDock set it.",
      lines: findComposerSafeAreaBottomPadding(files),
    },
    {
      fix: "Dashboard tests must not assert CSS utility classes. Assert the visible state, role, or text, or leave the look to visual QA.",
      lines: findDashboardUtilityAssertions(testFiles),
    },
  ].filter((check) => check.lines.length > 0);
  if (checks.length === 0) {
    console.log(
      "Dashboard source uses shared color tokens, type scale, and mobile-safe viewport padding.",
    );
    return;
  }
  const errors = checks.flatMap((check) => [
    check.fix,
    ...check.lines.map((line) => `  ${line}`),
  ]);
  errors.push(
    "Fix the design, not the match. Do not split class strings, build class names at runtime, or move values into inline styles to pass. See packages/junior-dashboard/src/client/components/AGENTS.md.",
  );
  console.error(["Dashboard style check failed:", ...errors].join("\n"));
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
