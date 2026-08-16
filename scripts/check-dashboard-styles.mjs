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
  const errors = [
    ...findNonstandardNeutralTextColors(files),
    ...findArbitraryTextSizes(files),
    ...findUndersizedHardcodedFontSizes(files),
    ...findClassicViewportHeights(files),
    ...findAdditiveSafeAreaPadding(files),
    ...findDashboardUtilityAssertions(testFiles),
  ];
  if (errors.length === 0) {
    console.log(
      "Dashboard source uses shared text tokens, type scale, and mobile-safe viewport padding.",
    );
    return;
  }
  console.error(["Dashboard style check failed:", ...errors].join("\n"));
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
