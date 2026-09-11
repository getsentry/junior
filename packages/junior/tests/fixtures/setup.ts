import { afterAll, expect, vi } from "vitest";

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
