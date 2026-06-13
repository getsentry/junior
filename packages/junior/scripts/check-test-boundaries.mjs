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
  /readCapturedSlackApiCalls/,
  /captured-slack-api-calls/,
  /getCapturedSlackApiCalls/,
  /queueSlackApiError/,
  /queueSlackRateLimit/,
  /@\/chat\/slack-actions\//,
  /auto_complete_mcp_oauth/,
  /auto_complete_oauth/,
  /credential_providers/,
  /fail_reply_call/,
  /mock_image_generation/,
  /plugin_dirs/,
  /plugin_packages/,
  /reply_results/,
  /reply_timeout_ms/,
  /reply_texts/,
  /skill_dirs/,
  /subscribed_decisions/,
  /unset_gateway_api_key/,
];

const VI_MODULE_MOCK_PATTERN = /\bvi\.(?:mock|doMock)\(\s*["']([^"']+)["']/g;
const OBSERVABILITY_LOGGING_MODULE = "@/chat/logging";
const OBSERVABILITY_SENTRY_MODULE = "@/chat/sentry";
const SENTRY_OBSERVABILITY_SIDE_EFFECT_PATTERN =
  /\b(?:captureException|captureMessage|spanToJSON|startInactiveSpan|startSpan|withActiveSpan)\b/;
const OBSERVABILITY_ASSERTION_PATTERN =
  /\bexpect\([^;\n]*(?:logException|logWarn|logInfo|setSpanAttributes|withSpan|captureException|startSpan|startInactiveSpan)[^;\n]*\)/g;
const LOGGING_CONTRACT_TEST_PATH_PATTERN = /(?:^|\/)tests\/unit\/logging\//;

function defaultBoundaryCheckRoots() {
  return {
    evalsRoot: path.join(monorepoRoot, "packages", "junior-evals", "evals"),
    evalTestsRoot: path.join(monorepoRoot, "packages", "junior-evals", "tests"),
    integrationRoot: path.join(juniorRoot, "tests", "integration"),
    mswRoot: path.join(juniorRoot, "tests", "msw"),
    reportRoot: monorepoRoot,
    testRoot: path.join(juniorRoot, "tests"),
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
      index: match.index,
      lineNumber: source.slice(0, match.index).split("\n").length,
      moduleName: match[1],
      snippet: source.slice(match.index, match.index + 1_200),
    });
    match = VI_MODULE_MOCK_PATTERN.exec(source);
  }

  return mocks;
}

function findPatternMatches(source, pattern) {
  const matches = [];
  pattern.lastIndex = 0;

  let match = pattern.exec(source);
  while (match) {
    matches.push({
      lineNumber: source.slice(0, match.index).split("\n").length,
    });
    match = pattern.exec(source);
  }

  return matches;
}

function isTestFile(filePath) {
  return /\.test\.[cm]?[jt]sx?$/.test(filePath);
}

function isLoggingContractTestPath(relativePath) {
  return LOGGING_CONTRACT_TEST_PATH_PATTERN.test(relativePath);
}

function isObservabilitySideEffectMock(mock) {
  if (mock.moduleName === OBSERVABILITY_LOGGING_MODULE) {
    return true;
  }
  return (
    mock.moduleName === OBSERVABILITY_SENTRY_MODULE &&
    SENTRY_OBSERVABILITY_SIDE_EFFECT_PATTERN.test(mock.snippet)
  );
}

async function checkMswDirectory(mswRoot, reportRoot) {
  if (!(await pathExists(mswRoot))) {
    return [];
  }

  const files = await listFilesRecursive(mswRoot);
  return files
    .filter(isTestFile)
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
  const testFiles = files.filter(isTestFile);

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

async function checkObservabilityBoundaries(testRoot, reportRoot) {
  if (!(await pathExists(testRoot))) {
    return [];
  }

  const violations = [];
  const files = await listFilesRecursive(testRoot);
  const testFiles = files.filter(isTestFile);

  for (const filePath of testFiles) {
    const source = await fs.readFile(filePath, "utf8");
    const relativePath = toRelative(filePath, reportRoot);
    if (isLoggingContractTestPath(relativePath)) {
      continue;
    }

    for (const mock of findViModuleMocks(source)) {
      if (!isObservabilitySideEffectMock(mock)) {
        continue;
      }
      violations.push(
        `Forbidden observability module mock "${mock.moduleName}" in ${relativePath}:${mock.lineNumber}. Observability mocks belong only in rare logging contract tests under tests/unit/logging/**.`,
      );
    }

    for (const match of findPatternMatches(
      source,
      OBSERVABILITY_ASSERTION_PATTERN,
    )) {
      violations.push(
        `Forbidden observability assertion in ${relativePath}:${match.lineNumber}. Telemetry assertions belong only in rare logging contract tests under tests/unit/logging/**.`,
      );
    }
  }

  return violations;
}

/** Return all boundary violations across Junior tests and evals. */
export async function runTestBoundaryCheck(roots = {}) {
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
    ...(await checkObservabilityBoundaries(
      resolvedRoots.testRoot,
      resolvedRoots.reportRoot,
    )),
    ...(await checkObservabilityBoundaries(
      resolvedRoots.evalTestsRoot,
      resolvedRoots.reportRoot,
    )),
  ];
}

async function main() {
  const violations = await runTestBoundaryCheck();

  if (violations.length > 0) {
    console.error("Test boundary check failed:");
    for (const violation of violations) {
      console.error(`- ${violation}`);
    }
    process.exit(1);
  }

  console.log("Test boundary check passed.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await main();
}
