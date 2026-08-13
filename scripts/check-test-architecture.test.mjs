import assert from "node:assert/strict";
import test from "node:test";
import { checkIntegrationTestArchitecture } from "./check-test-architecture.mjs";

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
      `${TEST_PATH}: integration tests must not mock Junior-owned @/ modules (1 found, 0 allowed)`,
    ],
  );
});

test("rejects dynamic mocks of Junior modules", () => {
  assert.deepEqual(
    checkIntegrationTestArchitecture([
      integrationTest("vi.doMock(\n  '@/chat/runtime',\n  () => ({}),\n);"),
    ]),
    [
      `${TEST_PATH}: integration tests must not mock Junior-owned @/ modules (1 found, 0 allowed)`,
    ],
  );
});

test("allows external mocks", () => {
  assert.deepEqual(
    checkIntegrationTestArchitecture([
      integrationTest('vi.mock("external-provider", () => ({}));'),
    ]),
    [],
  );
});

test("rejects Pi agent mocks", () => {
  assert.deepEqual(
    checkIntegrationTestArchitecture([
      integrationTest('vi.mock("@earendil-works/pi-agent-core", () => ({}));'),
    ]),
    [
      `${TEST_PATH}: integration tests must not mock Pi's agent (1 found, 0 allowed)`,
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

test("allows an exact recorded exception count", () => {
  assert.deepEqual(
    checkIntegrationTestArchitecture(
      [
        integrationTest(
          'import { completedAgentRun as finish } from "@/chat/runtime/agent-run-outcome";',
        ),
      ],
      { "manufactured-agent-outcome": { [TEST_PATH]: 1 } },
    ),
    [],
  );
});

test("rejects more violations than an exception allows", () => {
  assert.deepEqual(
    checkIntegrationTestArchitecture(
      [
        integrationTest(
          "scriptedAssistantMessageRunner({});\nscriptedAssistantMessageRunner({});",
        ),
      ],
      { "scripted-agent-runner": { [TEST_PATH]: 1 } },
    ),
    [
      `${TEST_PATH}: integration tests must use the model stream instead of a scripted agent runner (2 found, 1 allowed)`,
    ],
  );
});

test("rejects a stale exception count", () => {
  assert.deepEqual(
    checkIntegrationTestArchitecture(
      [integrationTest("scriptedAssistantMessageRunner({});")],
      { "scripted-agent-runner": { [TEST_PATH]: 2 } },
    ),
    [
      `scripts/test-architecture-debt.json: scripted-agent-runner allows 2 in ${TEST_PATH}, but 1 found; lower or remove the exception`,
    ],
  );
});

test("rejects unknown exception rules", () => {
  assert.deepEqual(
    checkIntegrationTestArchitecture([], {
      "unknown-rule": { [TEST_PATH]: 1 },
    }),
    ["scripts/test-architecture-debt.json: unknown rule unknown-rule"],
  );
});

test("rejects exceptions for rules with no existing debt", () => {
  assert.deepEqual(
    checkIntegrationTestArchitecture([], {
      "pi-agent-mock": { [TEST_PATH]: 1 },
    }),
    [
      "scripts/test-architecture-debt.json: pi-agent-mock does not allow exceptions",
    ],
  );
});

test("rejects invalid exception counts", () => {
  assert.deepEqual(
    checkIntegrationTestArchitecture([], {
      "manufactured-agent-outcome": { [TEST_PATH]: 0 },
    }),
    [
      `scripts/test-architecture-debt.json: manufactured-agent-outcome exception for ${TEST_PATH} must be a positive integer`,
    ],
  );
});
