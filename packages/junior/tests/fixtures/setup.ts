import { installTestClock } from "@sentry/junior-testing/clock";
import { afterAll, afterEach, beforeEach, expect, vi } from "vitest";

const clock = installTestClock();

// `Date` starts each test file and each test 5 s after the start of the
// current real minute, and then moves forward in real time. A test that runs
// for less than 55 s cannot cross a minute boundary by chance, and `Date`
// stays within a minute of Postgres `now()`. The clock keeps millisecond
// steps, so deadlines and timestamp order work as with the real clock.
// Fake timers from a test do not leak into the next test.
function startClock(): void {
  clock.set(Math.floor(clock.realNow() / 60_000) * 60_000 + 5_000);
}

startClock();

beforeEach(startClock);

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
// failed suites. Other test layers can replace these modules. A file that
// builds the app keeps its plugins until the file ends, so drop them too: the
// next file in the same worker then starts with no plugins.
afterAll(async () => {
  if (!isIntegrationTest()) return;
  const [{ closeDb }, { disconnectStateAdapter }, { installAppContext }] =
    await Promise.all([
      vi.importActual<typeof import("@/chat/db")>("@/chat/db"),
      importStateAdapter(),
      vi.importActual<typeof import("@/app/context")>("@/app/context"),
    ]);
  installAppContext(undefined);
  await disconnectStateAdapter();
  await closeDb();
});
