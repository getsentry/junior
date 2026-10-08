/**
 * Text reports of a Roach run, for logs and CI summaries.
 */
import { describeParts } from "./request-key.ts";
import type { RecordingMiss, RecordingStats } from "./types.ts";

/** Describe the totals of a run in one line. */
export function describeRecordingStats(stats: RecordingStats): string {
  const rules = Object.entries(stats.counts)
    .map(
      ([rule, { live, missed, replayed }]) =>
        `${rule} ${replayed} replayed, ${live} live${missed ? `, ${missed} missed` : ""}`,
    )
    .join("; ");
  const passthrough =
    Object.entries(stats.passthrough)
      .map(([origin, count]) => `${origin} ${count}`)
      .join(", ") || "none";
  return `${rules}. ${stats.written} recordings new or changed, ${stats.discarded} dropped from failed sessions. Not recorded: ${passthrough}.`;
}

/**
 * Describe the first request without a recording of each test, one line
 * each. The first miss of a test is the one to fix. Each later miss of the
 * test usually follows from it, because the live response differs from
 * the recording.
 */
export function describeRecordingMisses(misses: RecordingMiss[]): string[] {
  const seen = new Set<string | undefined>();
  return misses
    .filter((miss) => {
      const first = !seen.has(miss.session);
      seen.add(miss.session);
      return first;
    })
    .map((miss) => {
      const where = miss.session ?? "outside a test";
      const why = miss.closest
        ? `differs from ${miss.closest} at ${describeParts(miss.differs)}`
        : "no recording to compare";
      return `${where}: ${miss.rule} ${miss.file} ${why}`;
    });
}
