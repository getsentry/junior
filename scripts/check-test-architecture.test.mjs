import assert from "node:assert/strict";
import test from "node:test";
import { checkIntegrationInternalMocks } from "./check-test-architecture.mjs";

test("rejects a new integration test that mocks a Junior module", () => {
  assert.deepEqual(
    checkIntegrationInternalMocks([
      {
        path: "packages/junior/tests/integration/new.test.ts",
        contents: 'vi.mock("@/chat/runtime", () => ({}));',
      },
    ]),
    [
      "packages/junior/tests/integration/new.test.ts: integration tests must not mock Junior-owned @/ modules",
    ],
  );
});

test("rejects dynamic mocks of Junior modules", () => {
  assert.deepEqual(
    checkIntegrationInternalMocks([
      {
        path: "packages/junior/tests/integration/new.test.ts",
        contents: "vi.doMock(\n  '@/chat/runtime',\n  () => ({}),\n);",
      },
    ]),
    [
      "packages/junior/tests/integration/new.test.ts: integration tests must not mock Junior-owned @/ modules",
    ],
  );
});

test("allows external mocks", () => {
  assert.deepEqual(
    checkIntegrationInternalMocks([
      {
        path: "packages/junior/tests/integration/provider.test.ts",
        contents: 'vi.mock("@earendil-works/pi-agent-core", () => ({}));',
      },
    ]),
    [],
  );
});
