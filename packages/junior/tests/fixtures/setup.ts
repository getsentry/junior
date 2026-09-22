import { afterAll, beforeEach, expect, vi } from "vitest";
import { aiGatewayEmbeddingHandlers } from "../msw/handlers/ai-gateway";
import { mswServer } from "../msw/server";

// Memory recall embeds every prompt. Core tests answer that call locally;
// the shared MSW reset removes runtime handlers, so re-add them per test.
beforeEach(() => {
  mswServer.use(...aiGatewayEmbeddingHandlers);
});

// Release shared runtime handles after each integration test file, including
// failed suites. Other test layers can replace these modules.
afterAll(async () => {
  // oxlint-disable-next-line vitest/no-standalone-expect -- Vitest exposes the current file through assertion state.
  if (!expect.getState().testPath?.includes("/tests/integration/")) {
    return;
  }
  const [{ closeDb }, { disconnectStateAdapter }] = await Promise.all([
    vi.importActual<typeof import("@/chat/db")>("@/chat/db"),
    vi.importActual<typeof import("@/chat/state/adapter")>(
      "@/chat/state/adapter",
    ),
  ]);
  await disconnectStateAdapter();
  await closeDb();
});
