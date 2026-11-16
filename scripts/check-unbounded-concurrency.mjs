import { fileURLToPath } from "node:url";
import {
  compareToBaseline,
  countMatches,
  runRatchet,
} from "./source-ratchet.mjs";

/**
 * Unbounded concurrency ratchet for production source.
 * `Promise.all(items.map(fn))` starts one call per item at once, so the list
 * size sets the load on Slack, GitHub, Postgres, or Redis. The baseline lists
 * the per-file count that existed when this check was added. A count can only
 * go down.
 */

const RATCHET = {
  title: "Unbounded concurrency",
  label: "unbounded Promise.all over a list",
  baselinePath: "scripts/unbounded-concurrency-baseline.json",
  message:
    "Do not start one promise per item with `Promise.all(items.map(fn))`. Use `pLimit(LIMIT).map(items, fn)` from `p-limit` with a named concurrency constant. When each item runs one query, read all items in one query. A fixed set of different calls, `Promise.all([a(), b()])`, is allowed.",
  passMessage: "Production source adds no unbounded Promise.all over a list.",
};

const PATTERNS = `rule:
  any:
    - pattern: Promise.all($ITEMS.map($$$ARGS))
    - pattern: Promise.allSettled($ITEMS.map($$$ARGS))
    - pattern: Promise.all(Array.from($$$ARGS))
    - pattern: Promise.allSettled(Array.from($$$ARGS))`;

const RULES = ["TypeScript", "Tsx"]
  .map(
    (language) =>
      `id: unbounded-promise-all-${language.toLowerCase()}\nlanguage: ${language}\n${PATTERNS}`,
  )
  .join("\n---\n");

/**
 * Count unbounded `Promise.all` calls over a list per file. Paths in the
 * result are relative to `root`.
 */
export function countUnboundedConcurrency(root, targets) {
  return countMatches(root, targets, RULES);
}

/** Compare unbounded concurrency counts with the baseline. */
export function checkUnboundedConcurrency(counts, baseline) {
  return compareToBaseline(counts, baseline, RATCHET);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runRatchet({ ...RATCHET, rules: RULES });
}
