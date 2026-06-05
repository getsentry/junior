import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const juniorRoot = path.resolve(path.dirname(scriptPath), "..");
const monorepoRoot = path.resolve(juniorRoot, "../..");

const EVAL_SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

const FORBIDDEN_EVAL_PATTERNS = [
  /queueSlackApiResponse/,
  /getCapturedSlackApiCalls/,
  /queueSlackApiError/,
  /queueSlackRateLimit/,
  /@\/chat\/slack-actions\//,
];

const VI_MODULE_MOCK_PATTERN = /\bvi\.(?:mock|doMock)\(\s*["']([^"']+)["']/g;

function defaultBoundaryCheckRoots() {
  return {
    evalsRoot: path.join(monorepoRoot, "packages", "junior-evals", "evals"),
    integrationRoot: path.join(juniorRoot, "tests", "integration"),
    mswRoot: path.join(juniorRoot, "tests", "msw"),
    reportRoot: monorepoRoot,
  };
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function listFilesRecursive(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const nextPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(nextPath)));
      continue;
    }
    files.push(nextPath);
  }

  return files;
}

function toRelative(filePath, reportRoot) {
  return path.relative(reportRoot, filePath).split(path.sep).join("/");
}

function findPatternLineNumbers(source, pattern) {
  const lines = source.split("\n");
  const lineNumbers = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(lines[index])) {
      lineNumbers.push(index + 1);
    }
  }

  return lineNumbers;
}

function findViModuleMocks(source) {
  const mocks = [];
  VI_MODULE_MOCK_PATTERN.lastIndex = 0;

  let match = VI_MODULE_MOCK_PATTERN.exec(source);
  while (match) {
    mocks.push({
      lineNumber: source.slice(0, match.index).split("\n").length,
      moduleName: match[1],
    });
    match = VI_MODULE_MOCK_PATTERN.exec(source);
  }

  return mocks;
}

async function checkMswDirectory(mswRoot, reportRoot) {
  if (!(await pathExists(mswRoot))) {
    return [];
  }

  const files = await listFilesRecursive(mswRoot);
  return files
    .filter((filePath) => /\.test\.[cm]?[jt]sx?$/.test(filePath))
    .map(
      (filePath) =>
        `Unexpected test file under tests/msw: ${toRelative(filePath, reportRoot)}`,
    );
}

async function checkEvalSources(evalsRoot, reportRoot) {
  if (!(await pathExists(evalsRoot))) {
    return [];
  }

  const violations = [];
  const files = await listFilesRecursive(evalsRoot);

  for (const filePath of files) {
    const extension = path.extname(filePath);
    if (!EVAL_SOURCE_EXTENSIONS.has(extension)) {
      continue;
    }

    const source = await fs.readFile(filePath, "utf8");
    for (const pattern of FORBIDDEN_EVAL_PATTERNS) {
      const lineNumbers = findPatternLineNumbers(source, pattern);
      if (lineNumbers.length === 0) {
        continue;
      }
      violations.push(
        `Forbidden eval boundary pattern "${pattern.source}" in ${toRelative(filePath, reportRoot)} at line(s): ${lineNumbers.join(", ")}`,
      );
    }
  }

  return violations;
}

async function checkIntegrationSources(integrationRoot, reportRoot) {
  if (!(await pathExists(integrationRoot))) {
    return [];
  }

  const violations = [];
  const files = await listFilesRecursive(integrationRoot);
  const testFiles = files.filter((filePath) =>
    /\.test\.[cm]?[jt]sx?$/.test(filePath),
  );

  for (const filePath of testFiles) {
    const source = await fs.readFile(filePath, "utf8");
    const relativePath = toRelative(filePath, reportRoot);
    for (const mock of findViModuleMocks(source)) {
      violations.push(
        `Forbidden integration module mock "${mock.moduleName}" in ${relativePath}:${mock.lineNumber}. Integration tests must use real runtime wiring and fake deterministic agent/model output only through explicit composition or named harness ports.`,
      );
    }
  }

  return violations;
}

/** Return all test-boundary violations across Junior tests and evals. */
export async function runBoundaryCheck(roots = {}) {
  const resolvedRoots = {
    ...defaultBoundaryCheckRoots(),
    ...roots,
  };
  return [
    ...(await checkMswDirectory(
      resolvedRoots.mswRoot,
      resolvedRoots.reportRoot,
    )),
    ...(await checkEvalSources(
      resolvedRoots.evalsRoot,
      resolvedRoots.reportRoot,
    )),
    ...(await checkIntegrationSources(
      resolvedRoots.integrationRoot,
      resolvedRoots.reportRoot,
    )),
  ];
}

async function main() {
  const violations = await runBoundaryCheck();

  if (violations.length > 0) {
    console.error("Slack test boundary check failed:");
    for (const violation of violations) {
      console.error(`- ${violation}`);
    }
    process.exit(1);
  }

  console.log("Slack test boundary check passed.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await main();
}
