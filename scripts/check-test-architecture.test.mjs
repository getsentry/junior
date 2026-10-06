import assert from "node:assert/strict";
import test from "node:test";
import {
  checkAgentTestArchitecture,
  checkDatabaseTestFixtures,
  checkIntegrationTestArchitecture,
} from "./check-test-architecture.mjs";

const TEST_PATH = "packages/junior/tests/integration/new.test.ts";
const DASHBOARD_E2E_PATH =
  "packages/junior-dashboard/e2e/conversations.spec.ts";

function integrationTest(contents, path = TEST_PATH) {
  return { path, contents };
}

test("rejects a new integration test that mocks a Junior module", () => {
  assert.deepEqual(
    checkIntegrationTestArchitecture([
      integrationTest('vi.mock("@/chat/runtime", () => ({}));'),
    ]),
    [
      `${TEST_PATH}: integration tests must not use vi.mock or vi.doMock; fake only Slack and LLMs through shared harnesses (1 found, 0 allowed)`,
    ],
  );
});

test("rejects dynamic mocks", () => {
  assert.deepEqual(
    checkIntegrationTestArchitecture([
      integrationTest("vi.doMock(\n  '@/chat/runtime',\n  () => ({}),\n);"),
    ]),
    [
      `${TEST_PATH}: integration tests must not use vi.mock or vi.doMock; fake only Slack and LLMs through shared harnesses (1 found, 0 allowed)`,
    ],
  );
});

test("rejects external package mocks", () => {
  assert.deepEqual(
    checkIntegrationTestArchitecture([
      integrationTest('vi.mock("@vercel/sandbox", () => ({}));'),
    ]),
    [
      `${TEST_PATH}: integration tests must not use vi.mock or vi.doMock; fake only Slack and LLMs through shared harnesses (1 found, 0 allowed)`,
    ],
  );
});

test("rejects Pi agent mocks", () => {
  assert.deepEqual(
    checkIntegrationTestArchitecture([
      integrationTest('vi.mock("@earendil-works/pi-agent-core", () => ({}));'),
    ]),
    [
      `${TEST_PATH}: integration tests must not use vi.mock or vi.doMock; fake only Slack and LLMs through shared harnesses (1 found, 0 allowed)`,
    ],
  );
});

test("rejects manufactured agent outcomes", () => {
  assert.deepEqual(
    checkIntegrationTestArchitecture([
      integrationTest(
        [
          'import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";',
          'return { status: "awaiting_auth", providerDisplayName: "GitHub" };',
          'return ({ status: "suspended", reason: "timeout", resumeVersion: 2 });',
          'return { status: "completed", result };',
        ].join("\n"),
      ),
    ]),
    [
      `${TEST_PATH}: integration tests must run the real agent instead of manufacturing agent outcomes (4 found, 0 allowed)`,
    ],
  );
});

test("allows assertions about real agent outcomes", () => {
  assert.deepEqual(
    checkIntegrationTestArchitecture([
      integrationTest(
        'await expect(run).resolves.toEqual({ status: "completed" });',
      ),
    ]),
    [],
  );
});

test("rejects scripted agent runners", () => {
  assert.deepEqual(
    checkIntegrationTestArchitecture([
      integrationTest(
        "const runner = scriptedAssistantMessageRunner({ messages, result });",
      ),
    ]),
    [
      `${TEST_PATH}: integration tests must use the model stream instead of a scripted agent runner (1 found, 0 allowed)`,
    ],
  );
});

test("rejects direct agent dispatch worker composition", () => {
  assert.deepEqual(
    checkIntegrationTestArchitecture([
      integrationTest(
        [
          "const worker = createAgentDispatchConversationWorker(options);",
          "const route = createAgentDispatchWorkRouter({ dispatchWorker: worker });",
        ].join("\n"),
      ),
    ]),
    [
      `${TEST_PATH}: integration tests must compose agent dispatch through production conversation work (2 found, 0 allowed)`,
    ],
  );
});

test("rejects unsafe Slack double casts", () => {
  assert.deepEqual(
    checkIntegrationTestArchitecture([
      integrationTest("const thread = value as unknown as Thread;"),
    ]),
    [
      `${TEST_PATH}: integration tests must use typed Slack fixtures instead of double casts (1 found, 0 allowed)`,
    ],
  );
});

test("rejects fixed waits in dashboard E2E tests", () => {
  assert.deepEqual(
    checkIntegrationTestArchitecture([
      integrationTest("await page.waitForTimeout(100);", DASHBOARD_E2E_PATH),
    ]),
    [
      `${DASHBOARD_E2E_PATH}: dashboard E2E tests must wait for an observable state instead of a fixed delay (1 found, 0 allowed)`,
    ],
  );
});

test("rejects visual assertions in dashboard E2E tests", () => {
  assert.deepEqual(
    checkIntegrationTestArchitecture([
      integrationTest(
        "await expect(control).toHaveCSS('height', '44px');\nawait control.boundingBox();",
        DASHBOARD_E2E_PATH,
      ),
    ]),
    [
      `${DASHBOARD_E2E_PATH}: dashboard E2E tests must leave visual layout and style checks to visual QA (2 found, 0 allowed)`,
    ],
  );
});

test("allows screenshots in dashboard E2E tests", () => {
  assert.deepEqual(
    checkIntegrationTestArchitecture([
      integrationTest(
        'await page.screenshot({ path: "screenshots/settings.png" });',
        DASHBOARD_E2E_PATH,
      ),
    ]),
    [],
  );
});

test("rejects database fixture boundary bypasses", () => {
  assert.deepEqual(
    checkDatabaseTestFixtures([
      integrationTest(
        [
          'import { createEmptyJuniorSqlFixture } from "../fixtures/postgres/fixture";',
          'import { createPostgresTransactionFixture } from "@sentry/junior-testing/postgres";',
        ].join("\n"),
      ),
    ]),
    [
      `${TEST_PATH}: database tests must import fixtures through tests/fixtures/sql (2 found, 0 allowed)`,
      `${TEST_PATH}: only migration contract tests may use empty Junior SQL fixtures (1 found, 0 allowed)`,
    ],
  );
});

test("rejects the ambiguous local SQL fixture", () => {
  assert.deepEqual(
    checkDatabaseTestFixtures([
      integrationTest("await createLocalJuniorSqlFixture();"),
    ]),
    [
      `${TEST_PATH}: database tests must use createJuniorSqlFixture or createEmptyJuniorSqlFixture (1 found, 0 allowed)`,
    ],
  );
});

test("allows the shared migrated SQL fixture", () => {
  assert.deepEqual(
    checkDatabaseTestFixtures([
      integrationTest(
        'import { createJuniorSqlFixture } from "../fixtures/sql";\nawait createJuniorSqlFixture();',
      ),
    ]),
    [],
  );
});

test("allows the empty SQL fixture only in migration contract tests", () => {
  assert.deepEqual(
    checkDatabaseTestFixtures([
      integrationTest(
        'import { createEmptyJuniorSqlFixture } from "../fixtures/sql";\nawait createEmptyJuniorSqlFixture();',
        "packages/junior/tests/integration/conversation-sql.test.ts",
      ),
    ]),
    [],
  );
});

test("rejects broad browser error assertions in dashboard E2E tests", () => {
  assert.deepEqual(
    checkIntegrationTestArchitecture([
      integrationTest(
        [
          "collectBrowserErrors(page);",
          'page.on("console", handleConsole);',
          'page.on("pageerror", handlePageError);',
        ].join("\n"),
        DASHBOARD_E2E_PATH,
      ),
    ]),
    [
      `${DASHBOARD_E2E_PATH}: dashboard E2E tests must assert the journey outcome instead of broad browser error silence (3 found, 0 allowed)`,
    ],
  );
});

test("scopes dashboard E2E rules to dashboard browser specs", () => {
  assert.deepEqual(
    checkIntegrationTestArchitecture([
      integrationTest("await control.boundingBox();"),
    ]),
    [],
  );
});

const EVAL_PATH = "packages/junior-evals/evals/conversation/new.eval.ts";

test("rejects agent test contract violations above the baseline", () => {
  assert.deepEqual(
    checkAgentTestArchitecture(
      [
        integrationTest(
          'vi.mock("@/chat/pi/client", () => ({}));\nsetPlugins([]);',
        ),
        integrationTest(
          [
            'import { getDb } from "@/chat/db";',
            'import { mention } from "../../src/helpers";',
            'import { test } from "../../src/fixture/test";',
          ].join("\n"),
          EVAL_PATH,
        ),
      ],
      {},
    ),
    [
      `${EVAL_PATH}: agent tests must import only the agent test fixture, the public app API, plugin packages, and test libraries (3 found, 0 allowed)`,
      `${TEST_PATH}: tests must not fake the model; run the real agent through the agent test fixture (1 found, 0 allowed)`,
      `${TEST_PATH}: tests must not mutate runtime config or reload modules; pass options to createApp() or agent() (1 found, 0 allowed)`,
    ],
  );
});

test("requires a lower baseline when a file breaks a rule less", () => {
  assert.deepEqual(
    checkAgentTestArchitecture([integrationTest("setPlugins([]);")], {
      "runtime-config-mutation": { [TEST_PATH]: 2 },
    }),
    [
      `${TEST_PATH}: runtime-config-mutation baseline allows 2 but 1 found; lower the entry in scripts/test-architecture-baseline.json`,
    ],
  );
});

test("allows agent tests to import the fixture, the public app API, plugin packages, and test libraries", () => {
  assert.deepEqual(
    checkAgentTestArchitecture(
      [
        integrationTest(
          [
            'import { expect } from "vitest";',
            'import { toolCalls } from "vitest-evals";',
            'import type { JuniorAppOptions } from "@sentry/junior";',
            'import { defineJuniorPlugins } from "@sentry/junior";',
            'import { githubPlugin } from "@sentry/junior-github";',
            'import { mention, test } from "@junior-evals/fixture/test";',
            'import { launchHistory } from "./helpers";',
          ].join("\n"),
          EVAL_PATH,
        ),
        integrationTest(
          'import { getDb } from "@/chat/db";\nprocessConversationQueueMessage(message);',
          "packages/junior-evals/src/fixture/agent.ts",
        ),
        integrationTest(
          'import { getDb } from "@/chat/db";',
          "packages/junior-evals/evals/router/new.eval.ts",
        ),
      ],
      {},
    ),
    [],
  );
});
