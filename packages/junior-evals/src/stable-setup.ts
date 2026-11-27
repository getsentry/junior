/**
 * Process-wide inputs that every eval suite keeps the same, because
 * recordings replay only equal requests: UTC time zone, `Math.random` seeded
 * per test, and the eval clock. `crypto.randomUUID` stays real on purpose:
 * Vercel Sandbox reuses a sandbox by name, so repeated UUIDs would share
 * sandboxes between runs. `roach.json` replaces UUIDs in requests instead.
 */
import { relative } from "node:path";
import { beforeEach } from "vitest";
import { installTestClock } from "@sentry/junior-testing/clock";
import { EVAL_START_MS } from "./eval-clock";

process.env["TZ"] = "UTC";

const evalClock = installTestClock();

// Install one generator per worker and only reseed it per test. Code that a
// test runs can make `Math.random` read-only, so a later assignment throws.
// Setup files run again for each test file in a worker, so the generator
// lives on `globalThis`.
const SEEDED_RANDOM = Symbol.for("junior-evals.seeded-random");
type SeededRandom = { seed(text: string): void };
const globals = globalThis as { [SEEDED_RANDOM]?: SeededRandom };
const seededRandom = (globals[SEEDED_RANDOM] ??= installSeededRandom());

beforeEach(({ task }) => {
  evalClock.set(EVAL_START_MS);
  seededRandom.seed(
    `${relative(process.cwd(), task.file.filepath)} > ${task.fullName}`,
  );
});

/**
 * Replace `Math.random` with a small fast generator (mulberry32). `seed()`
 * restarts it with a seed from the given text (FNV-1a).
 */
function installSeededRandom(): SeededRandom {
  let state = 0;
  const seed = (text: string) => {
    state = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      state = Math.imul(state ^ text.charCodeAt(index), 0x01000193);
    }
  };
  seed("junior-evals");
  Object.defineProperty(Math, "random", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: () => {
      state = (state + 0x6d2b79f5) | 0;
      let value = Math.imul(state ^ (state >>> 15), 1 | state);
      value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    },
  });
  return { seed };
}
