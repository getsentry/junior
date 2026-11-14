/**
 * The eval clock: `Date` that starts each test at the same instant.
 *
 * Recordings keep the times that the model calculates from "now", such as
 * the end of a search window three days later. If "now" changed between the
 * recording run and the replay, tools would compare those old times with a
 * later clock, and the requests would not match the recordings.
 *
 * The clock replaces only `Date`. It moves forward in real time from the
 * start of each test, so waits and deadlines still work. Timers and
 * `performance.now()` stay real.
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

/** Control of the eval clock in one process. */
export interface EvalClock {
  /** Set the eval time. The clock moves forward in real time from it. */
  set(nowMs: number): void;
  /** The real time, for checks of real external tokens. */
  realNow(): number;
}

// Setup files run again for each test file in a worker, so the clock lives
// on `globalThis`. A second install would wrap the first one.
const EVAL_CLOCK = Symbol.for("junior-evals.clock");

/** Replace `Date` with the eval clock one time in this process. */
export function installEvalClock(): EvalClock {
  const globals = globalThis as { [EVAL_CLOCK]?: EvalClock };
  return (globals[EVAL_CLOCK] ??= replaceDate());
}

function replaceDate(): EvalClock {
  const RealDate = Date;
  let offsetMs = 0;
  const now = () => RealDate.now() + offsetMs;
  // A proxy keeps `instanceof Date`, `Date.prototype`, and subclasses of
  // `Date` working. Only `Date.now()`, `new Date()`, and `Date()` change.
  globalThis.Date = new Proxy(RealDate, {
    apply: () => new RealDate(now()).toString(),
    construct: (target, args, newTarget) =>
      Reflect.construct(target, args.length === 0 ? [now()] : args, newTarget),
    get: (target, key, receiver) =>
      key === "now" ? now : Reflect.get(target, key, receiver),
  });
  return {
    set: (nowMs) => {
      offsetMs = nowMs - RealDate.now();
    },
    realNow: () => RealDate.now(),
  };
}
