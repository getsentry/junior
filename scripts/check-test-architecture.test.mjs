import assert from "node:assert/strict";
import test from "node:test";
import {
  checkAgentTestArchitecture,
  checkDatabaseTestFixtures,
  checkIntegrationTestArchitecture,
  DASHBOARD_SPEC_RULES,
  SOURCE_RULES,
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
      `${TEST_PATH}: integration tests must not use vi.mock or vi.doMock; fake only Slack and LLMs through shared harnesses (1 found)`,
    ],
  );
});

test("rejects dynamic mocks", () => {
  assert.deepEqual(
    checkIntegrationTestArchitecture([
      integrationTest("vi.doMock(\n  '@/chat/runtime',\n  () => ({}),\n);"),
    ]),
    [
      `${TEST_PATH}: integration tests must not use vi.mock or vi.doMock; fake only Slack and LLMs through shared harnesses (1 found)`,
    ],
  );
});

test("rejects external package mocks", () => {
  assert.deepEqual(
    checkIntegrationTestArchitecture([
      integrationTest('vi.mock("@vercel/sandbox", () => ({}));'),
    ]),
    [
      `${TEST_PATH}: integration tests must not use vi.mock or vi.doMock; fake only Slack and LLMs through shared harnesses (1 found)`,
    ],
  );
});

test("rejects Pi agent mocks", () => {
  assert.deepEqual(
    checkIntegrationTestArchitecture([
      integrationTest('vi.mock("@earendil-works/pi-agent-core", () => ({}));'),
    ]),
    [
      `${TEST_PATH}: integration tests must not use vi.mock or vi.doMock; fake only Slack and LLMs through shared harnesses (1 found)`,
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
      `${TEST_PATH}: integration tests must run the real agent instead of manufacturing agent outcomes (4 found)`,
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
      `${TEST_PATH}: integration tests must use the model stream instead of a scripted agent runner (1 found)`,
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
      `${TEST_PATH}: integration tests must compose agent dispatch through production conversation work (2 found)`,
    ],
  );
});

test("rejects unsafe Slack double casts", () => {
  assert.deepEqual(
    checkIntegrationTestArchitecture([
      integrationTest("const thread = value as unknown as Thread;"),
    ]),
    [
      `${TEST_PATH}: integration tests must use typed Slack fixtures instead of double casts (1 found)`,
    ],
  );
});

test("rejects fixed waits in dashboard E2E tests", () => {
  assert.deepEqual(
    checkIntegrationTestArchitecture([
      integrationTest("await page.waitForTimeout(100);", DASHBOARD_E2E_PATH),
    ]),
    [
      `${DASHBOARD_E2E_PATH}: dashboard E2E tests must wait for an observable state instead of a fixed delay (1 found)`,
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
      `${DASHBOARD_E2E_PATH}: dashboard E2E tests must leave visual layout and style checks to visual QA (2 found)`,
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
      `${TEST_PATH}: database tests must import fixtures through tests/fixtures/sql (2 found)`,
      `${TEST_PATH}: only migration contract tests may use empty Junior SQL fixtures (1 found)`,
    ],
  );
});

test("rejects the ambiguous local SQL fixture", () => {
  assert.deepEqual(
    checkDatabaseTestFixtures([
      integrationTest("await createLocalJuniorSqlFixture();"),
    ]),
    [
      `${TEST_PATH}: database tests must use createJuniorSqlFixture or createEmptyJuniorSqlFixture (1 found)`,
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
      `${DASHBOARD_E2E_PATH}: dashboard E2E tests must assert the journey outcome instead of broad browser error silence (3 found)`,
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

test("rejects page script, synthetic events, selectors, and timing in dashboard E2E specs", () => {
  assert.deepEqual(
    checkAgentTestArchitecture(
      [
        integrationTest(
          [
            "await page.evaluate(() => window.scrollY);",
            "await row.evaluateHandle((node) => node.parentElement);",
            'await input.dispatchEvent("paste");',
            'await page.locator("[data-inbox-row]").click();',
            "await expect(row).toBeVisible({ timeout: 15_000 });",
          ].join("\n"),
          DASHBOARD_E2E_PATH,
        ),
      ],
      {},
      DASHBOARD_SPEC_RULES,
    ),
    [
      `${DASHBOARD_E2E_PATH}: dashboard E2E specs must not run script in the page; assert what the user sees, or move a needed read into a named helper outside the spec (2 found)`,
      `${DASHBOARD_E2E_PATH}: dashboard E2E specs must not dispatch synthetic events; use real input such as click, fill, press, or setInputFiles (1 found)`,
      `${DASHBOARD_E2E_PATH}: dashboard E2E specs must not pass a CSS or attribute selector to locator(); use getByRole, getByLabel, or getByText (1 found)`,
      `${DASHBOARD_E2E_PATH}: dashboard E2E specs must not override timeouts; control time with page.clock and wait for a visible state (1 found)`,
    ],
  );
});

test("allows user-level dashboard E2E specs and page script in shared helpers", () => {
  assert.deepEqual(
    checkAgentTestArchitecture(
      [
        integrationTest(
          [
            'await page.getByRole("button", { name: "Send" }).click();',
            'await page.getByLabel("Message").fill("hi");',
            'await expect(page.getByText("Sent")).toBeVisible();',
            'await page.clock.runFor("00:30");',
          ].join("\n"),
          DASHBOARD_E2E_PATH,
        ),
        integrationTest(
          "return page.evaluate(() => window.scrollY);",
          "packages/junior-dashboard/e2e/harness.ts",
        ),
      ],
      {},
      DASHBOARD_SPEC_RULES,
    ),
    [],
  );
});

const DASHBOARD_HELPER_PATH = "packages/junior-dashboard/e2e/harness.ts";

/** Check one dashboard E2E rule on a spec and a helper with the same text. */
function dashboardE2eErrors(ruleId, contents) {
  return checkAgentTestArchitecture(
    [
      integrationTest(contents, DASHBOARD_E2E_PATH),
      integrationTest(contents, DASHBOARD_HELPER_PATH),
    ],
    {},
    DASHBOARD_SPEC_RULES.filter((rule) => rule.id === ruleId),
  ).map((error) => error.split(":")[0]);
}

test("rejects toPass retries and network idle waits in dashboard E2E specs and helpers", () => {
  assert.deepEqual(
    dashboardE2eErrors(
      "dashboard-e2e-retry-loop",
      "await expect(async () => { await item.hover(); }).toPass();",
    ),
    [DASHBOARD_E2E_PATH, DASHBOARD_HELPER_PATH],
  );
  assert.deepEqual(
    dashboardE2eErrors(
      "dashboard-e2e-network-idle",
      'await page.goto(url, { waitUntil: "networkidle" });',
    ),
    [DASHBOARD_E2E_PATH, DASHBOARD_HELPER_PATH],
  );
});

test("rejects forwarded routes in dashboard E2E specs and helpers", () => {
  assert.deepEqual(
    dashboardE2eErrors(
      "dashboard-e2e-route-forward",
      "const response = await route.fetch();",
    ),
    [DASHBOARD_E2E_PATH, DASHBOARD_HELPER_PATH],
  );
});

test("rejects ignored route handler errors in dashboard E2E specs and helpers", () => {
  assert.deepEqual(
    dashboardE2eErrors(
      "dashboard-e2e-ignore-route-errors",
      'await page.unrouteAll({ behavior: "ignoreErrors" });',
    ),
    [DASHBOARD_E2E_PATH, DASHBOARD_HELPER_PATH],
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
            'import { slackMention } from "../../src/helpers";',
            'import { test } from "../../src/fixture/test";',
          ].join("\n"),
          EVAL_PATH,
        ),
      ],
      {},
    ),
    [
      `${EVAL_PATH}: agent tests must import only the agent test fixture, the public app API, plugin packages, and test libraries (3 found)`,
      `${TEST_PATH}: tests must not fake the model; run the real agent through the agent test fixture (1 found)`,
      `${TEST_PATH}: tests must not mutate runtime config or reload modules; pass options to createApp() or agent() (1 found)`,
    ],
  );
});

test("rejects a process.env assignment in integration tests and fixtures", () => {
  const contents = "process.env = { ...ORIGINAL_ENV };";
  assert.deepEqual(
    checkAgentTestArchitecture(
      [
        integrationTest(contents),
        integrationTest(contents, "packages/junior/tests/fixtures/env.ts"),
        integrationTest(contents, "packages/junior/tests/unit/env.test.ts"),
        integrationTest('if (process.env === env) vi.stubEnv("A", "1");'),
      ],
      {},
    ),
    [
      `${TEST_PATH}: integration tests and test fixtures must change env with vi.stubEnv, not assign a new object to process.env (1 found)`,
      "packages/junior/tests/fixtures/env.ts: integration tests and test fixtures must change env with vi.stubEnv, not assign a new object to process.env (1 found)",
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
            'import { slackMention, test } from "@junior-evals/fixture/test";',
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
          "packages/junior-evals/evals/classifiers/new.eval.ts",
        ),
      ],
      {},
    ),
    [],
  );
});

test("rejects a new kind branch outside kind-behavior.ts", () => {
  const source = (path, contents) => ({ path, contents });
  const branch = 'if (conversation.kind === "thread") {}';
  assert.equal(
    checkAgentTestArchitecture(
      [
        source("packages/junior/src/chat/new.ts", branch),
        source(
          "packages/junior/src/chat/conversations/kind-behavior.ts",
          branch,
        ),
        source(
          "packages/junior/src/chat/old.ts",
          "run.dispatch?.declaresResult",
        ),
      ],
      { "kind-behavior": { "packages/junior/src/chat/old.ts": 1 } },
      SOURCE_RULES,
    ).length,
    1,
  );
});

test("counts each form of a kind branch", () => {
  const branches = [
    "if (x.parentConversationId) {}",
    "if (!parentConversationId) {}",
    "const child = Boolean(row && row.parentConversationId);",
    "const root = conversation?.parentConversationId ? a : b;",
    "if (invocation.parentToolCallId !== undefined) {}",
    "const messages = spawnAgent || run.agentInvocationId;",
    'if (message.source === "web") {}',
    'if (data.meta?.["source"] === "web") {}',
    'const id = typeof meta?.["agentInvocationId"] === "string";',
    "switch (run.source.kind) {}",
    'if ("automation" === kind) {}',
    "const result = run.dispatch?.declaresResult === true;",
    "if (!isTopLevelKind(conversation.kind)) {}",
  ];
  const notBranches = [
    "parentConversationId?: string;",
    "declaresResult?: boolean;",
    "const row = { parentConversationId: id, declaresResult: true };",
    'const ts = source.kind === "slack" ? source.threadTs : undefined;',
    "const parent = run.parentConversationId ?? root;",
    "// if (x.parentConversationId) is a comment.",
  ];
  const count = (contents) =>
    checkAgentTestArchitecture(
      [{ path: "packages/junior/src/chat/new.ts", contents }],
      {},
      SOURCE_RULES,
    ).length;
  assert.deepEqual(
    branches.map(count),
    branches.map(() => 1),
  );
  assert.deepEqual(
    notBranches.map(count),
    notBranches.map(() => 0),
  );
});
