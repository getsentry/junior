import { afterAll, afterEach, expect, vi } from "vitest";

function isIntegrationTest(): boolean {
  // oxlint-disable-next-line vitest/no-standalone-expect -- Vitest exposes the current file through assertion state.
  return expect.getState().testPath?.includes("/tests/integration/") ?? false;
}

async function importStateAdapter() {
  return await vi.importActual<typeof import("@/chat/state/adapter")>(
    "@/chat/state/adapter",
  );
}

// Each integration test starts with an empty database. State caches rows of
// it, such as the identity cache, so each test also gets an empty state.
afterEach(async () => {
  if (!isIntegrationTest()) return;
  await (await importStateAdapter()).disconnectStateAdapter();
});

// Release shared runtime handles after each integration test file, including
// failed suites. Other test layers can replace these modules.
afterAll(async () => {
  if (!isIntegrationTest()) return;
  const [{ closeDb }, { disconnectStateAdapter }] = await Promise.all([
    vi.importActual<typeof import("@/chat/db")>("@/chat/db"),
    importStateAdapter(),
  ]);
  await disconnectStateAdapter();
  await closeDb();
});
