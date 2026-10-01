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
  "packages/junior/tests/component/memory/host-wiring.test.ts",
  "packages/junior/tests/component/plugins/plugin-migrations.test.ts",
  "packages/junior/tests/component/scheduled-automations-sql.test.ts",
  "packages/junior/tests/integration/conversation-sql.test.ts",
  "packages/junior/tests/integration/workspace-snapshot-migration.test.ts",
]);

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
