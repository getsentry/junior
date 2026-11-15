import { installTestClock } from "@sentry/junior-testing/clock";
import { afterAll, afterEach, beforeEach, expect, vi } from "vitest";

const clock = installTestClock();

/** Every test starts at this instant, on a whole minute. */
const TEST_START_MS = Date.parse("2026-10-01T12:05:00.000Z");

// `Date` starts each test file and each test at the same instant, so
// wall-clock reads are the same in every run and a test cannot cross a
// minute, day, or month boundary by chance. The clock then moves forward in
// real time and keeps millisecond steps, so deadlines and timestamp order
// work as with the real clock. Fake timers from a test do not leak into the
// next test.
clock.set(TEST_START_MS);

beforeEach(() => {
  clock.set(TEST_START_MS);
});

afterEach(() => {
  vi.useRealTimers();
});

function isIntegrationTest(): boolean {
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
