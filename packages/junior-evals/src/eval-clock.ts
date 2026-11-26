/**
 * The eval clock: `Date` that starts each test at the same instant
 * (`@sentry/junior-testing/clock`).
 *
 * Recordings keep the times that the model calculates from "now", such as
 * the end of a search window three days later. If "now" changed between the
 * recording run and the replay, tools would compare those old times with a
 * later clock, and the requests would not match the recordings.
 *
 * The clock replaces only `Date`. It moves forward in real time from the
 * start of each test, so waits and deadlines still work. Timers and
 * `performance.now()` stay real, because time budgets use it. So Pi's
 * `durationMs` on saved messages changes on each run, and so does the
 * `payload_json_bytes` of a saved message that event search leaves out.
 * The `pi-duration-ms` and `payload-json-bytes` values of the model rule
 * in `roach.json` replace them in requests.
 *
 * The eval worker and the main process both install the clock. The worker
 * makes leases, tokens, and fixture credentials with its clock, and the main
 * process checks them when it handles sandbox egress. So the worker sends
 * its time to the main process at the start of each test
 * (`src/setup.ts`). Checks of real external tokens, such as Vercel OIDC
 * tokens, must use `realNow()`.
 */

/**
 * The instant at the start of each test: Monday, October 12, 2026, 9:00 AM
 * Pacific time. It must stay in the past. Real tokens that the worker reads,
 * such as `VERCEL_OIDC_TOKEN`, are then not expired by the eval clock.
 */
export const EVAL_START_MS = Date.parse("2026-10-12T16:00:00Z");
