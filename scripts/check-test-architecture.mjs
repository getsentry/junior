import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_ROOTS = [
  "packages/junior/tests/integration",
  "packages/junior-dashboard/e2e",
];
const DATABASE_TEST_ROOTS = [
  "packages/junior/tests/component",
  "packages/junior/tests/integration",
];
const DASHBOARD_E2E_ROOT = "packages/junior-dashboard/e2e/";
const EMPTY_DATABASE_TESTS = new Set([
  "packages/junior/tests/component/conversation-storage-sql.test.ts",
  "packages/junior/tests/component/memory-plugin-storage.test.ts",
  "packages/junior/tests/component/scheduled-automations-sql.test.ts",
  "packages/junior/tests/integration/conversation-sql.test.ts",
  "packages/junior/tests/integration/workspace-snapshot-migration.test.ts",
]);

const AGENT_TEST_ROOTS = ["packages/junior/tests", "packages/junior-evals"];
const AGENT_FIXTURE_ROOT = "packages/junior-evals/src/fixture/";
const AGENT_FIXTURE_ALIAS = "@junior-evals/fixture/";
const JUNIOR_TESTS_ROOT = "packages/junior/tests/";
const AGENT_EVALS_ROOT = "packages/junior-evals/evals/";
// Guardian and router evals call one model boundary and do not run the agent.
const ISOLATED_EVAL_ROOTS = [
  "packages/junior-evals/evals/guardian/",
  "packages/junior-evals/evals/router/",
];
const AGENT_TEST_BASELINE_PATH = "scripts/test-architecture-baseline.json";

const RULES = [
  {
    // Slack and LLM fakes go through shared harnesses, not vi.mock.
    message:
      "integration tests must not use vi.mock or vi.doMock; fake only Slack and LLMs through shared harnesses",
    pattern: /\bvi\.(?:doMock|mock)\s*\(/g,
  },
  {
    message:
      "integration tests must run the real agent instead of manufacturing agent outcomes",
    pattern:
      /\bcompletedAgentRun\b|\breturn\s*\(?\s*\{\s*status:\s*["'](?:completed|awaiting_auth|suspended)["']/g,
  },
  {
    message:
      "integration tests must use the model stream instead of a scripted agent runner",
    pattern:
      /\b(?:scriptedAssistantMessageRunner|createApiTurnScriptedRunner)\b/g,
  },
  {
    message:
      "integration tests must compose agent dispatch through production conversation work",
    pattern:
      /\b(?:createAgentDispatchConversationWorker|createAgentDispatchWorkRouter)\s*\(/g,
  },
  {
    message:
      "integration tests must use typed Slack fixtures instead of double casts",
    pattern:
      /\bas\s+unknown\s+as\s+(?:SlackAdapter|Thread|Message)(?:\b|\s*<)/g,
  },
  {
    message:
      "dashboard E2E tests must wait for an observable state instead of a fixed delay",
    pathPrefix: DASHBOARD_E2E_ROOT,
    pattern: /\bwaitForTimeout\s*\(/g,
  },
  {
    message:
      "dashboard E2E tests must leave visual layout and style checks to visual QA",
    pathPrefix: DASHBOARD_E2E_ROOT,
    pattern: /\b(?:boundingBox|getBoundingClientRect|toHaveCSS)\s*\(/g,
  },
  {
    message:
      "dashboard E2E tests must assert the journey outcome instead of broad browser error silence",
    pathPrefix: DASHBOARD_E2E_ROOT,
    pattern:
      /\bcollectBrowserErrors\s*\(|\bpage\.on\s*\(\s*["'](?:console|pageerror)["']/g,
  },
];

/**
 * Rules from the agent test fixture contract. Each rule has a baseline list of
 * the files that break it today. A list can only get shorter.
 */
const AGENT_TEST_RULES = [
  {
    id: "junior-tests-run-agent",
    message:
      "tests in packages/junior/tests must not run the agent; move the test to an eval that uses the agent test fixture",
    pathPrefix: JUNIOR_TESTS_ROOT,
    pattern:
      /\b(?:executeAgentRun|createAgentRunner|createModelAgentRunner(?:ForRun)?|realAgentRunner|createConversationWebHarness|createConversationWorkSlackHarness|createTestChatRuntime|createModelStream|streamReplies|streamScript|mockAnthropicStream)\b/g,
  },
  {
    id: "agent-test-imports",
    message:
      "agent tests must import only the agent test fixture, the public app API, plugin packages, and test libraries",
    pathPrefix: AGENT_EVALS_ROOT,
    count: countForbiddenAgentTestImports,
  },
  {
    id: "model-fakes",
    message:
      "tests must not fake the model; run the real agent through the agent test fixture",
    pattern:
      /\bvi\.(?:doMock|mock)\(\s*["'](?:@earendil-works\/pi-agent-core|@\/chat\/pi\/client)["']|\bclass\s+MockAgent\b|\b(?:createFauxCore|fauxAssistantMessage)\b|\b(?:completeObject|completeText)\s*:|\bhttp\.\w+\(\s*["'`]https:\/\/ai-gateway\.vercel\.sh/g,
  },
  {
    id: "runtime-config-mutation",
    message:
      "tests must not mutate runtime config or reload modules; pass options to createApp() or agent()",
    pattern:
      /\bsetPlugins\(|\bObject\.assign\(\s*botConfig\b|\bvi\.resetModules\(/g,
  },
  {
    id: "runtime-composition",
    message:
      "only the agent test fixture may compose the conversation worker or Slack runtime",
    pattern:
      /\b(?:processConversationQueueMessage|createSlackRuntime|createConversationWork)\(/g,
  },
];

const IMPORT_PATTERN =
  /\bimport\s+(type\s+)?(?:[^"';]*?\s+from\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;

/** Count value imports from outside the fixture, the public app API, plugin packages, and test libraries. */
function countForbiddenAgentTestImports(file) {
  let count = 0;
  for (const match of file.contents.matchAll(IMPORT_PATTERN)) {
    const typeOnly = Boolean(match[1]);
    const source = match[2] ?? match[3];
    if (!allowedAgentTestImport(file.path, source, typeOnly)) count += 1;
  }
  return count;
}

function allowedAgentTestImport(filePath, source, typeOnly) {
  if (/^(?:vitest|vitest-evals)(?:\/|$)/.test(source)) return true;
  if (typeOnly && source.startsWith("@sentry/")) return true;
  // Tests configure the agent as a host does: the public app API and plugin
  // packages. Test helpers and the dashboard are not public API.
  if (
    /^@sentry\/junior(?:-(?!testing$|evals$|dashboard$)[a-z-]+)?$/.test(source)
  ) {
    return true;
  }
  if (source.startsWith(AGENT_FIXTURE_ALIAS)) return true;
  if (!source.startsWith(".")) return false;
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(filePath), source),
  );
  // Fixture imports use the alias; relative imports stay inside evals.
  return resolved.startsWith(AGENT_EVALS_ROOT);
}

function agentRuleApplies(rule, filePath) {
  if (filePath.startsWith(AGENT_FIXTURE_ROOT)) return false;
  if (rule.pathPrefix && !filePath.startsWith(rule.pathPrefix)) return false;
  if (
    rule.pathPrefix === AGENT_EVALS_ROOT &&
    ISOLATED_EVAL_ROOTS.some((root) => filePath.startsWith(root))
  ) {
    return false;
  }
  return true;
}

/** Count agent test contract violations by rule and file. */
export function collectAgentTestViolations(files) {
  const violations = {};
  for (const rule of AGENT_TEST_RULES) {
    const byFile = {};
    for (const file of files) {
      if (!agentRuleApplies(rule, file.path)) continue;
      const actual = rule.count
        ? rule.count(file)
        : countMatches(file.contents, rule.pattern);
      if (actual > 0) byFile[file.path] = actual;
    }
    violations[rule.id] = byFile;
  }
  return violations;
}

/**
 * Report agent test contract violations above the baseline. A baseline entry
 * that is now too high must be lowered, so each list only gets shorter.
 */
export function checkAgentTestArchitecture(files, baseline) {
  const errors = [];
  const violations = collectAgentTestViolations(files);
  for (const rule of AGENT_TEST_RULES) {
    const actualByFile = violations[rule.id];
    const allowedByFile = baseline[rule.id] ?? {};
    for (const [filePath, actual] of Object.entries(actualByFile)) {
      const allowed = allowedByFile[filePath] ?? 0;
      if (actual > allowed) {
        errors.push(
          `${filePath}: ${rule.message} (${actual} found, ${allowed} allowed)`,
        );
      }
    }
    for (const [filePath, allowed] of Object.entries(allowedByFile)) {
      const actual = actualByFile[filePath] ?? 0;
      if (actual < allowed) {
        errors.push(
          `${filePath}: ${rule.id} baseline allows ${allowed} but ${actual} found; lower the entry in ${AGENT_TEST_BASELINE_PATH}`,
        );
      }
    }
  }
  return errors;
}

function countMatches(contents, pattern) {
  return Array.from(contents.matchAll(pattern)).length;
}

/** Report integration test architecture violations. */
export function checkIntegrationTestArchitecture(files) {
  const errors = [];

  for (const rule of RULES) {
    for (const file of files) {
      if (rule.pathPrefix && !file.path.startsWith(rule.pathPrefix)) {
        continue;
      }
      const actual = countMatches(file.contents, rule.pattern);
      if (actual > 0) {
        errors.push(
          `${file.path}: ${rule.message} (${actual} found, 0 allowed)`,
        );
      }
    }
  }

  return errors;
}

/** Report SQL fixture boundary violations. */
export function checkDatabaseTestFixtures(files) {
  const errors = [];
  for (const file of files) {
    const directFixtureImports = countMatches(
      file.contents,
      /(?:fixtures\/postgres\/fixture|@sentry\/junior-testing\/postgres)/g,
    );
    if (directFixtureImports > 0) {
      errors.push(
        `${file.path}: database tests must import fixtures through tests/fixtures/sql (${directFixtureImports} found, 0 allowed)`,
      );
    }
    const legacyFixtures = countMatches(
      file.contents,
      /\bcreateLocalJuniorSqlFixture\b/g,
    );
    if (legacyFixtures > 0) {
      errors.push(
        `${file.path}: database tests must use createJuniorSqlFixture or createEmptyJuniorSqlFixture (${legacyFixtures} found, 0 allowed)`,
      );
    }
    const emptyFixtures = countMatches(
      file.contents,
      /\bcreateEmptyJunior(?:Postgres|Sql)Fixture\b/g,
    );
    if (emptyFixtures > 0 && !EMPTY_DATABASE_TESTS.has(file.path)) {
      errors.push(
        `${file.path}: only migration contract tests may use empty Junior SQL fixtures (${emptyFixtures} found, 0 allowed)`,
      );
    }
  }
  return errors;
}

function collectSourceFiles(root, roots) {
  return roots.flatMap((testRoot) => {
    const directory = path.join(root, testRoot);
    return fs
      .readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          /\.(?:ts|mts|mjs)$/.test(entry.name) &&
          !entry.parentPath.split(path.sep).includes("node_modules"),
      )
      .map((entry) => {
        const absolutePath = path.join(entry.parentPath, entry.name);
        return {
          path: path.relative(root, absolutePath).split(path.sep).join("/"),
          contents: fs.readFileSync(absolutePath, "utf8"),
        };
      });
  });
}

function collectTests(root, testRoots = TEST_ROOTS) {
  return testRoots.flatMap((testRoot) => {
    const directory = path.join(root, testRoot);
    return fs
      .readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          (entry.name.endsWith(".test.ts") || entry.name.endsWith(".spec.ts")),
      )
      .map((entry) => {
        const absolutePath = path.join(entry.parentPath, entry.name);
        return {
          path: path.relative(root, absolutePath).split(path.sep).join("/"),
          contents: fs.readFileSync(absolutePath, "utf8"),
        };
      });
  });
}

function main() {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(scriptDirectory, "..");
  const errors = [
    ...checkIntegrationTestArchitecture(collectTests(root)),
    ...checkDatabaseTestFixtures(collectTests(root, DATABASE_TEST_ROOTS)),
    ...checkAgentTestArchitecture(
      collectSourceFiles(root, AGENT_TEST_ROOTS),
      JSON.parse(
        fs.readFileSync(path.join(root, AGENT_TEST_BASELINE_PATH), "utf8"),
      ),
    ),
  ];
  if (errors.length === 0) {
    console.log("Tests follow test architecture policy.");
    return;
  }
  console.error(["Test architecture check failed:", ...errors].join("\n"));
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
