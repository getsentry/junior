import { installTestClock } from "@sentry/junior-testing/clock";

/**
 * Use the real time for the rest of this test, instead of the fixed start
 * that `tests/fixtures/setup.ts` sets. Use it only when code compares times
 * with a clock outside this process, such as Postgres `now()` or a real S3
 * server.
 */
export function useRealClock(): void {
  const clock = installTestClock();
  clock.set(clock.realNow());
}
