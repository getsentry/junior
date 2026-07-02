import type {
  RequesterDirectoryReport,
  RequesterIdentity,
  RequesterSummaryReport,
  RequesterTotalsReport,
} from "./types";
import {
  addSignals,
  emptyTotals,
  identityWithEmail,
  mergeIdentity,
  reportDate,
  reportTime,
  requesterRows,
  SAMPLE_LIMIT,
  signals,
  summaryFromRow,
  type PeopleApiQueryOptions,
} from "./shared";

type DirectoryAccumulator = RequesterTotalsReport & {
  activeDates: Set<string>;
  firstSeenMs: number;
  lastSeenMs: number;
  requester: RequesterIdentity & { email: string };
};

function directoryItem(
  accumulator: DirectoryAccumulator,
): RequesterSummaryReport {
  return {
    active: accumulator.active,
    activeDays: accumulator.activeDates.size,
    conversations: accumulator.conversations,
    durationMs: accumulator.durationMs,
    failed: accumulator.failed,
    firstSeenAt: new Date(accumulator.firstSeenMs).toISOString(),
    hung: accumulator.hung,
    lastSeenAt: new Date(accumulator.lastSeenMs).toISOString(),
    requester: accumulator.requester,
    runs: accumulator.runs,
  };
}

/** Load the people list from the configured or injected SQL database. */
export async function readPeopleListFromSql(
  options: PeopleApiQueryOptions = {},
): Promise<RequesterDirectoryReport> {
  const nowMs = Date.now();
  const { rows, truncated } = await requesterRows(options);
  const people = new Map<string, DirectoryAccumulator>();

  for (const row of rows) {
    const summary = summaryFromRow(row, nowMs);
    const requester = identityWithEmail(summary.requesterIdentity);
    if (!requester) continue;

    const firstSeenMs =
      reportTime(summary.startedAt) ?? row.createdAt.getTime();
    const lastSeenMs =
      reportTime(summary.lastSeenAt) ?? row.lastActivityAt.getTime();
    const date = reportDate(summary.lastSeenAt);
    const accumulator =
      people.get(requester.email) ??
      ({
        ...emptyTotals(),
        activeDates: new Set<string>(),
        firstSeenMs,
        lastSeenMs,
        requester,
      } satisfies DirectoryAccumulator);

    accumulator.requester = mergeIdentity(accumulator.requester, requester);
    accumulator.conversations += 1;
    accumulator.runs += 1;
    addSignals(accumulator, signals(summary));
    accumulator.firstSeenMs = Math.min(accumulator.firstSeenMs, firstSeenMs);
    accumulator.lastSeenMs = Math.max(accumulator.lastSeenMs, lastSeenMs);
    if (date) accumulator.activeDates.add(date);
    people.set(requester.email, accumulator);
  }

  return {
    generatedAt: new Date(nowMs).toISOString(),
    people: [...people.values()]
      .map(directoryItem)
      .sort(
        (left, right) =>
          (reportTime(right.lastSeenAt) ?? 0) -
            (reportTime(left.lastSeenAt) ?? 0) ||
          right.conversations - left.conversations ||
          left.requester.email.localeCompare(right.requester.email),
      ),
    sampleLimit: SAMPLE_LIMIT,
    sampleSize: rows.length,
    source: "conversation_index",
    truncated,
  };
}
