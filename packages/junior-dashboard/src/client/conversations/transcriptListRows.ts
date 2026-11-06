import {
  isCollapsibleActivityEntry,
  quietTurnEntryKeys,
} from "./TranscriptActivityGroup";
import type { RenderedTranscriptEntry } from "./transcriptRenderModel";
import { entryMatchesSearch } from "./transcriptSearch";
import type { TranscriptUnreadRange } from "./transcriptReadPosition";

/** One row of the rich transcript list, in seq order. */
export type TranscriptListRow =
  | { kind: "unread_marker"; key: string }
  | {
      kind: "entry";
      entry: RenderedTranscriptEntry;
      key: string;
      seq?: number;
    }
  | {
      kind: "activity";
      entries: RenderedTranscriptEntry[];
      key: string;
      /** Last event sequence in the group. */
      seq?: number;
    };

/** The key of the "New" marker row. */
export const UNREAD_MARKER_KEY = "unread-marker";

/**
 * Turn transcript entries into list rows. Runs of collapsible activity
 * become one group row, search drops rows that do not match, and the
 * "New" marker becomes its own row before the first unread row.
 *
 * `knownActivityKeys` maps entry keys to group keys across calls, so a
 * group keeps its key while events extend either edge.
 */
export function transcriptListRows(input: {
  entries: readonly RenderedTranscriptEntry[];
  keyPrefix: string;
  knownActivityKeys: Map<string, string>;
  /** The normalized search query, when search is active. */
  search?: string;
  unread?: TranscriptUnreadRange;
}): TranscriptListRow[] {
  const { entries, search } = input;
  const quietKeys = quietTurnEntryKeys(entries);
  const collapsible = (entry: RenderedTranscriptEntry) =>
    isCollapsibleActivityEntry(entry) || quietKeys.has(entry.key);
  const matches = (entry: RenderedTranscriptEntry) =>
    search === undefined || entryMatchesSearch(entry, search);
  const claimedActivityKeys = new Set<string>();
  const rows: TranscriptListRow[] = [];
  // Search results are not a reading order, so they get no marker.
  const markerSeq =
    search === undefined ? unreadMarkerSeq(entries, input.unread) : undefined;
  let markerPending = markerSeq !== undefined;
  // Entries are in seq order, so the first row that reaches the marker seq
  // gets the marker.
  const pushRow = (
    row: Exclude<TranscriptListRow, { kind: "unread_marker" }>,
  ) => {
    if (markerPending && row.seq !== undefined && row.seq >= markerSeq!) {
      markerPending = false;
      rows.push({ kind: "unread_marker", key: UNREAD_MARKER_KEY });
    }
    rows.push(row);
  };

  for (let index = 0; index < entries.length; ) {
    const entry = entries[index]!;
    if (collapsible(entry)) {
      const group: RenderedTranscriptEntry[] = [];
      while (index < entries.length && collapsible(entries[index]!)) {
        group.push(entries[index]!);
        index += 1;
      }
      const visible = group.filter(matches);
      if (visible.length > 0) {
        // The marker goes before the group when any of it is unread.
        pushRow({
          kind: "activity",
          entries: visible,
          key: stableActivityGroupKey({
            claimedKeys: claimedActivityKeys,
            entries: group,
            keyPrefix: input.keyPrefix,
            knownKeys: input.knownActivityKeys,
          }),
          seq: lastEntrySeq(group),
        });
      }
      continue;
    }
    if (matches(entry)) {
      pushRow({
        kind: "entry",
        entry,
        key: `${input.keyPrefix}:${entry.key}`,
        seq: entry.seq,
      });
    }
    index += 1;
  }
  return rows;
}

/**
 * Find the first row whose last seq is at or after `seq`. The New marker
 * sorts with the row before it, and other rows without a seq come last, so a
 * binary search works. Returns `rows.length` when no row reaches it.
 */
export function rowIndexForSeq(
  rows: readonly TranscriptListRow[],
  seq: number,
): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const row = rows[middle]!;
    const rowSeq =
      row.kind === "unread_marker"
        ? (rowSeqBefore(rows, middle) ?? Number.NEGATIVE_INFINITY)
        : row.seq;
    if (rowSeq !== undefined && rowSeq < seq) low = middle + 1;
    else high = middle;
  }
  return low;
}

function rowSeqBefore(
  rows: readonly TranscriptListRow[],
  index: number,
): number | undefined {
  const row = rows[index - 1];
  return row === undefined || row.kind === "unread_marker"
    ? undefined
    : row.seq;
}

/**
 * Group rows whose heights are alike, so a row can borrow the measured
 * height of others before it renders.
 */
export function transcriptRowSizeClass(row: TranscriptListRow): string {
  if (row.kind !== "entry") return row.kind;
  const { entry } = row;
  return entry.kind === "message"
    ? `message:${entry.message.role}`
    : entry.kind;
}

/** Guess the height of a row of a size class before any of them measure. */
export function defaultTranscriptRowSize(sizeClass: string): number {
  if (sizeClass === "unread_marker") return 32;
  if (sizeClass === "activity") return 36;
  if (sizeClass === "attachments_delivered") return 240;
  if (sizeClass === "message:assistant") return 120;
  if (sizeClass.startsWith("message:")) return 80;
  return 44;
}

/**
 * Find the seq of the first unread row. Entries are in seq order, and pending
 * sends without a seq come last, so a binary search finds the first seq after
 * the read position. Rows after the range arrived after open, so they get no
 * marker.
 */
function unreadMarkerSeq(
  entries: readonly RenderedTranscriptEntry[],
  unread: TranscriptUnreadRange | undefined,
): number | undefined {
  if (!unread) return undefined;
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const seq = entries[middle]!.seq;
    if (seq !== undefined && seq <= unread.afterSeq) low = middle + 1;
    else high = middle;
  }
  const seq = entries[low]?.seq;
  return seq !== undefined && seq <= unread.throughSeq ? seq : undefined;
}

function lastEntrySeq(
  entries: readonly RenderedTranscriptEntry[],
): number | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const seq = entries[index]!.seq;
    if (seq !== undefined) return seq;
  }
  return undefined;
}

/** Keep one activity group mounted while new or historical events extend either edge. */
function stableActivityGroupKey(args: {
  claimedKeys: Set<string>;
  entries: RenderedTranscriptEntry[];
  keyPrefix: string;
  knownKeys: Map<string, string>;
}): string {
  const entryKeys = args.entries.map(
    (entry) => `${args.keyPrefix}:${entry.key}`,
  );
  const knownKey = entryKeys
    .map((entryKey) => args.knownKeys.get(entryKey))
    .find((key) => key !== undefined && !args.claimedKeys.has(key));
  const groupKey =
    knownKey ?? `${args.keyPrefix}:activity:${args.entries[0]!.key}`;

  args.claimedKeys.add(groupKey);
  entryKeys.forEach((entryKey) => args.knownKeys.set(entryKey, groupKey));
  return groupKey;
}
