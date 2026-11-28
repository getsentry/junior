import { installTestClock } from "@sentry/junior-testing/clock";
import { afterAll, afterEach, beforeEach, expect, vi } from "vitest";
import { resetAiEmulator } from "./ai-emulator-server";

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

afterEach(resetAiEmulator);

function isIntegrationTest(): boolean {
  return expect.getState().testPath?.includes("/tests/integration/") ?? false;
}

async function importStateAdapter() {
  return await vi.importActual<typeof import("@/chat/state/adapter")>(
    "@/chat/state/adapter",
  );
}

async function importAppContext() {
  return await vi.importActual<typeof import("@/app/context")>("@/app/context");
}

// The app context that was installed when the current integration test
// started. Other layers mock modules that the context imports, so only
// integration tests import it here.
let testBaseContext: import("@/app/context").AppContext | undefined;

beforeEach(async () => {
  if (!isIntegrationTest()) return;
  const { installAppContext } = await importAppContext();
  testBaseContext = installAppContext(undefined);
  installAppContext(testBaseContext);
});

// A context that a test builds, such as with createApp, closes when the test
// ends, and the context from before the test comes back.
afterEach(async () => {
  if (!isIntegrationTest()) return;
  const { installAppContext } = await importAppContext();
  const current = installAppContext(testBaseContext);
  if (current && current !== testBaseContext) {
    await Promise.allSettled(current.conversationTitles.values());
    await current.close();
  }
});

// Each integration test starts with an empty database. State caches rows of
// it, such as the identity cache, so each test also gets an empty state.
// Title work runs in the background and writes its Conversation, so it ends
// in the test that started it, not after the next test empties the database.
afterEach(async () => {
  if (!isIntegrationTest()) return;
  const { getAppContext } = await importAppContext();
  await Promise.allSettled(getAppContext().conversationTitles.values());
  await (await importStateAdapter()).disconnectStateAdapter();
});

// Release the app context after each integration test file, including failed
// suites. Files in a worker share modules, so the next file then starts with
// no context and no plugins.
afterAll(async () => {
  if (!isIntegrationTest()) return;
  const { installAppContext } = await importAppContext();
  await installAppContext(undefined)?.close();
});
