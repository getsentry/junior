/**
 * Stable ids for tests that run the agent.
 *
 * Ids from `randomUUID()` reach model requests, for example in tool results
 * or in ids that the product derives from them. Recordings replay only equal
 * requests, so the fixture takes its ids from the test name.
 */
import { createHash } from "node:crypto";
import { relative } from "node:path";
import { expect } from "vitest";

const fixtureIdCounts = new Map<string, number>();

/**
 * An id that comes from the current test, a kind, and a count. A test gets
 * the same ids on each run. Different tests get different ids.
 */
export function fixtureId(kind: string, length: number): string {
  const { currentTestName, testPath } = expect.getState();
  const test = `${testPath ? relative(process.cwd(), testPath) : ""} > ${currentTestName ?? ""}`;
  const scope = `${test} > ${kind}`;
  const count = (fixtureIdCounts.get(scope) ?? 0) + 1;
  fixtureIdCounts.set(scope, count);
  return createHash("sha256")
    .update(`${scope} > ${count}`)
    .digest("hex")
    .slice(0, length);
}
