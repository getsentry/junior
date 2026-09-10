/**
 * Renewable wait before an event-sourced Turn runs, so a burst of watch
 * events can collect into one Turn instead of one Turn per event.
 *
 * Each additional event in the batch nudges the wait later by a small step.
 * The wait is bounded by a cap measured from the first event, so a busy
 * watch cannot delay a Turn indefinitely.
 */
const EVENT_WAKE_BASE_DELAY_MS = 30_000;
const EVENT_WAKE_STEP_DELAY_MS = 5_000;
const EVENT_WAKE_MAX_DELAY_MS = 60_000;

/**
 * Return the remaining wait before an event-sourced Turn should run, or
 * `undefined` once the batch has waited long enough to run now.
 */
export function remainingEventWakeDelayMs(args: {
  eventCount: number;
  firstReceivedAtMs: number;
  nowMs: number;
}): number | undefined {
  const waitMs = Math.min(
    EVENT_WAKE_MAX_DELAY_MS,
    EVENT_WAKE_BASE_DELAY_MS +
      EVENT_WAKE_STEP_DELAY_MS * (args.eventCount - 1),
  );
  const remainingMs = args.firstReceivedAtMs + waitMs - args.nowMs;
  return remainingMs > 0 ? remainingMs : undefined;
}
