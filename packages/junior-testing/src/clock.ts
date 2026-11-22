/** Control of the test clock in one process. */
export interface TestClock {
  /**
   * Set the time of `Date`. The clock moves forward in real time from it.
   * This also puts the clock back on `globalThis.Date`, because
   * `vi.useRealTimers()` can replace it with the real `Date`.
   */
  set(nowMs: number): void;
  /** The real time, for checks of real external times and tokens. */
  realNow(): number;
}

// Setup files run again for each test file in a worker, so the clock lives
// on `globalThis`. A second install would wrap the first one.
const TEST_CLOCK = Symbol.for("junior-testing.clock");

/**
 * Replace `Date` one time in this process with a clock that a test can start
 * at a fixed instant. Only `Date.now()`, `new Date()`, and `Date()` change.
 * Timers and `performance.now()` stay real.
 */
export function installTestClock(): TestClock {
  const globals = globalThis as { [TEST_CLOCK]?: TestClock };
  return (globals[TEST_CLOCK] ??= replaceDate());
}

function replaceDate(): TestClock {
  const RealDate = Date;
  const realNow = RealDate.now;
  let offsetMs = 0;
  const now = () => realNow() + offsetMs;
  // A proxy keeps `instanceof Date`, `Date.prototype`, and subclasses of
  // `Date` working. `vi.spyOn(Date, "now")` reads the clock as the original
  // `now` and puts the spy on the real `Date`. The spy then answers.
  const ClockDate = new Proxy(RealDate, {
    apply: () => new RealDate(now()).toString(),
    construct: (target, args, newTarget) =>
      Reflect.construct(target, args.length === 0 ? [now()] : args, newTarget),
    getOwnPropertyDescriptor: (target, key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      return key === "now" && descriptor?.value === realNow
        ? { ...descriptor, value: now }
        : descriptor;
    },
    get: (target, key, receiver) =>
      key === "now" && target.now === realNow
        ? now
        : // A Proxy trap forwards other keys with Reflect.
          // oxlint-disable-next-line anti-slop/no-reflect-get
          Reflect.get(target, key, receiver),
  });
  globalThis.Date = ClockDate;
  return {
    set: (nowMs) => {
      globalThis.Date = ClockDate;
      offsetMs = nowMs - realNow();
    },
    realNow,
  };
}
