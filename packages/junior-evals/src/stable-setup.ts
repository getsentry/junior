/**
 * Process-wide inputs that every eval suite keeps the same on each run.
 *
 * Every eval config loads this setup file first. Recordings replay only
 * equal requests, so a value that changes on each run makes a miss.
 *
 * - The time zone is UTC. Local times, such as `iso_local` and
 *   `timezone_offset_minutes` from the `systemTime` tool, then do not change
 *   with the machine that records.
 * - `Math.random` has a seed from the test file and the test name. The same
 *   test gets the same values on each run, and different tests get different
 *   values. Ids that the product and the AI SDK make with it, such as
 *   conversation memory ids, then do not change.
 *
 * Two things stay real on purpose:
 *
 * - The clock. The worker shares state with processes that use the real
 *   clock: the main process checks sandbox egress leases that the worker
 *   writes, and it verifies Vercel OIDC tokens, which have real `nbf` and
 *   `exp` times. Postgres also writes `now()` defaults. A fake clock in the
 *   worker breaks those checks. The `values` of the model rule in
 *   `recording-rules.ts` replace times and dates in requests instead.
 * - `crypto.randomUUID`. Sandbox names and workspace snapshot names come from
 *   it, and Vercel Sandbox reuses a sandbox by name. Repeated UUIDs would
 *   share sandboxes between runs and pull requests. The `uuid` value of the
 *   model rule replaces UUIDs in requests instead.
 */
import { relative } from "node:path";
import { beforeEach } from "vitest";

process.env.TZ = "UTC";

// Install one generator for the whole worker and only change its state per
// test. Code that a test runs can leave `Math.random` read-only. A later
// assignment then throws, which failed the second test of
// `evals/sentry/skills.eval.ts`. Setup files run again for each test file in
// the same worker, so the generator is kept on `globalThis` and installed once.
const SEEDED_RANDOM = Symbol.for("junior-evals.seeded-random");
type SeededRandom = { seed(text: string): void };
const globals = globalThis as { [SEEDED_RANDOM]?: SeededRandom };
const seededRandom = (globals[SEEDED_RANDOM] ??= installSeededRandom());

beforeEach(({ task }) => {
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
