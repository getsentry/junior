import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();

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

const INTEGRATION_ROOT = path.join(repoRoot, "tests", "integration");
const VI_MODULE_MOCK_PATTERN = /\bvi\.(?:mock|doMock)\(\s*["']([^"']+)["']/g;

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

function toRelative(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
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
  const lines = source.split("\n");
  const mocks = [];

  for (let index = 0; index < lines.length; index += 1) {
    VI_MODULE_MOCK_PATTERN.lastIndex = 0;
    let match = VI_MODULE_MOCK_PATTERN.exec(lines[index]);
    while (match) {
      mocks.push({
        lineNumber: index + 1,
        moduleName: match[1],
      });
      match = VI_MODULE_MOCK_PATTERN.exec(lines[index]);
    }
  }

  return mocks;
}

async function checkMswDirectory() {
  const mswPath = path.join(repoRoot, "tests", "msw");
  if (!(await pathExists(mswPath))) {
    return [];
  }

  const files = await listFilesRecursive(mswPath);
  return files
    .filter((filePath) => /\.test\.[cm]?[jt]sx?$/.test(filePath))
    .map(
      (filePath) =>
        `Unexpected test file under tests/msw: ${toRelative(filePath)}`,
    );
}

async function checkEvalSources() {
  const evalsPath = path.join(repoRoot, "evals");
  if (!(await pathExists(evalsPath))) {
    return [];
  }

  const violations = [];
  const files = await listFilesRecursive(evalsPath);

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
        `Forbidden eval boundary pattern "${pattern.source}" in ${toRelative(filePath)} at line(s): ${lineNumbers.join(", ")}`,
      );
    }
  }

  return violations;
}

async function checkIntegrationSources() {
  if (!(await pathExists(INTEGRATION_ROOT))) {
    return [];
  }

  const violations = [];
  const files = await listFilesRecursive(INTEGRATION_ROOT);
  const testFiles = files.filter((filePath) =>
    /\.test\.[cm]?[jt]sx?$/.test(filePath),
  );

  for (const filePath of testFiles) {
    const source = await fs.readFile(filePath, "utf8");
    const relativePath = toRelative(filePath);
    for (const mock of findViModuleMocks(source)) {
      violations.push(
        `Forbidden integration module mock "${mock.moduleName}" in ${relativePath}:${mock.lineNumber}. Integration tests must use real runtime wiring and fake deterministic agent/model output only through explicit composition or request-context ports.`,
      );
    }
  }

  return violations;
}

async function main() {
  const violations = [
    ...(await checkMswDirectory()),
    ...(await checkEvalSources()),
    ...(await checkIntegrationSources()),
  ];

  if (violations.length > 0) {
    console.error("Slack test boundary check failed:");
    for (const violation of violations) {
      console.error(`- ${violation}`);
    }
    process.exit(1);
  }

  console.log("Slack test boundary check passed.");
}

await main();
