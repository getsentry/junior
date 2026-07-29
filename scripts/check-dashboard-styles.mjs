import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LEGACY_WHITE_TEXT_PATTERN = /text-white(?:\/\d+)?\b/;
const LEGACY_SECONDARY_TEXT_PATTERN = /text-dashboard-text-secondary/;
const ARBITRARY_TEXT_COLOR_PATTERN = /text-\[#([\da-f]{3}|[\da-f]{6})\]/gi;
const UTILITY_ASSERTION_PATTERN =
  /\bexpect\(.+\)\.(?:not\.)?(?:toBe|toContain|toEqual|toMatch)\([^)]*["'`](?:[a-z-]+:)*(?:bg|col-span|flex|grid|overflow|row-span|text)-/;

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
    ...findDashboardUtilityAssertions(testFiles),
  ];
  if (errors.length === 0) {
    console.log("Dashboard source uses shared neutral text colors.");
    return;
  }
  console.error(["Dashboard style check failed:", ...errors].join("\n"));
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
