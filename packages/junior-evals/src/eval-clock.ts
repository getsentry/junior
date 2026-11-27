/**
 * The eval clock (`@sentry/junior-testing/clock`): `Date` starts each test at
 * the same instant, so times the model derives from "now" match recordings.
 * It moves in real time; timers and `performance.now()` stay real. The worker
 * sends its time to the main process, which checks the worker's tokens. Real
 * external tokens, such as Vercel OIDC tokens, must use `realNow()`.
 */

/**
 * The instant at the start of each test: Monday, October 12, 2026, 9:00 AM
 * Pacific time. It must stay in the past. Real tokens that the worker reads,
 * such as `VERCEL_OIDC_TOKEN`, are then not expired by the eval clock.
 */
export const EVAL_START_MS = Date.parse("2026-10-12T16:00:00Z");
