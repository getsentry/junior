import { installTestClock } from "@sentry/junior-testing/clock";
import { afterEach, beforeEach, vi } from "vitest";
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
