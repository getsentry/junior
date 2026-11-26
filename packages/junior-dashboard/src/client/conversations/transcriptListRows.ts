import {
  isCollapsibleActivityEntry,
  quietTurnEntryKeys,
  routineEventEntryKeys,
} from "./TranscriptActivityGroup";
import { inboxItemIdFromToolCall } from "../inbox/inboxItemFormat";
import { isMemoryCaptureEvent } from "./conversationMemory";
import type { RenderedTranscriptEntry } from "./transcriptRenderModel";
import { entryMatchesSearch } from "./transcriptSearch";
import type { TranscriptUnreadRange } from "./transcriptReadPosition";
import { calendarDay, calendarDaysAgo, formatTime } from "../time";

type SubagentEntry = Extract<RenderedTranscriptEntry, { kind: "subagent" }>;

/** One row of the rich transcript list, in seq order. */
export type TranscriptListRow =
  | { kind: "unread_marker"; key: string }
  | {
      kind: "entry";
      entry: RenderedTranscriptEntry;
      key: string;
      seq?: number | undefined;
      /** The Tasks of the Turn that this reply ends. */
      tasks?: SubagentEntry[];
    }
  | {
      kind: "activity";
      entries: RenderedTranscriptEntry[];
      key: string;
      /** Last event sequence in the group. */
      seq?: number | undefined;
    }
  | {
      kind: "tasks";
      entries: SubagentEntry[];
      key: string;
      /** Last event sequence in the group. */
      seq?: number | undefined;
    };

/** The key of the "New" marker row. */
export const UNREAD_MARKER_KEY = "unread-marker";

/**
 * Turn transcript entries into list rows. Runs of collapsible activity,
 * with routine Watch Events, become one group row,
 * a Thread keeps its own row, search drops rows that do not match, and the
 * "New" marker becomes its own row before the first unread row. The Tasks of a Turn move to its end, so they do not split its
 * activity: under its reply, or in a Tasks row when it has no reply yet. A
 * question that Junior asked moves after them, and shows once: at its last
 * change, since a later Turn changes the same item by its id.
 * Memory capture events do not show: the turn context and the details panel
 * hold a Turn's memories.
 *
 * `knownActivityKeys` maps entry keys to group keys across calls, so a
 * group keeps its key while events extend either edge.
 */
export function transcriptListRows(input: {
  entries: readonly RenderedTranscriptEntry[];
  keyPrefix: string;
  knownActivityKeys: Map<string, string>;
  /** The normalized search query, when search is active. */
  search?: string | undefined;
  unread?: TranscriptUnreadRange | undefined;
}): TranscriptListRow[] {
  const { entries, search } = input;
  const quietKeys = quietTurnEntryKeys(entries);
  const routineKeys = routineEventEntryKeys(entries);
  const collapsible = (entry: RenderedTranscriptEntry) =>
    isCollapsibleActivityEntry(entry) ||
    quietKeys.has(entry.key) ||
    routineKeys.has(entry.key);
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
  // The reader sees why Junior asks before the question. A moved row keeps
  // the seq of the row before it, so the rows stay in seq order. An unread
  // ask still gets the marker before it.
  let asks: RenderedTranscriptEntry[] = [];
  const pushAsks = () => {
    for (const ask of asks) {
      if (!matches(ask)) continue;
      if (markerPending && ask.seq !== undefined && ask.seq >= markerSeq!) {
        markerPending = false;
        rows.push({ kind: "unread_marker", key: UNREAD_MARKER_KEY });
      }
      pushRow({
        kind: "entry",
        entry: ask,
        key: `${input.keyPrefix}:${ask.key}`,
        seq: lastRowSeq(rows) ?? ask.seq,
      });
    }
    asks = [];
  };
  let tasks: SubagentEntry[] = [];
  const pushTurnEnd = () => {
    const visible = tasks.filter(matches);
    if (visible.length > 0) {
      const rowSeq = lastRowSeq(rows);
      const taskSeq = lastEntrySeq(tasks);
      // The row moves after later rows, so it takes the larger seq.
      const seq =
        rowSeq === undefined || taskSeq === undefined
          ? (rowSeq ?? taskSeq)
          : Math.max(rowSeq, taskSeq);
      const last = rows.at(-1);
      if (last?.kind === "entry" && isReplyEntry(last.entry)) {
        // The Tasks sit under the reply text, before its actions. The reply
        // goes back through pushRow, so unread Tasks still get the marker.
        rows.pop();
        pushRow({ ...last, seq, tasks: visible });
      } else {
        pushRow({
          kind: "tasks",
          entries: visible,
          // New Tasks join at the end, so the first one keeps the key.
          key: `${input.keyPrefix}:tasks:${tasks[0]!.key}`,
          seq,
        });
      }
    }
    tasks = [];
    pushAsks();
  };
  const lastAskKeys = lastAskEntryKeys(entries);
  // Asks and Tasks move out of their place in the Turn. Memory captures
  // and earlier asks of the same item drop out.
  const moveOut = (entry: RenderedTranscriptEntry): boolean => {
    if (isAskEntry(entry)) {
      if (lastAskKeys.has(entry.key)) asks.push(entry);
      return true;
    }
    if (isTaskEntry(entry)) tasks.push(entry);
    else if (!isCaptureEntry(entry)) return false;
    return true;
  };

  for (let index = 0; index < entries.length;) {
    const entry = entries[index]!;
    if (moveOut(entry)) {
      index += 1;
      continue;
    }
    // A message from a person starts the next Turn. So does a routine
    // Event, which folds into activity but can still start a Turn.
    if (
      entry.kind === "message" &&
      entry.message.role === "user" &&
      (!collapsible(entry) || routineKeys.has(entry.key))
    ) {
      pushTurnEnd();
    }
    if (collapsible(entry)) {
      const group: RenderedTranscriptEntry[] = [];
      // An entry that moves out leaves the activity on both sides of it as
      // one row.
      while (index < entries.length) {
        const next = entries[index]!;
        if (!moveOut(next)) {
          if (!collapsible(next)) break;
          // The Tasks and asks of the Turn before a routine Event go after
          // that Turn's reply, so the Event starts a new group.
          if (
            group.length > 0 &&
            routineKeys.has(next.key) &&
            (tasks.length > 0 || asks.length > 0)
          ) {
            break;
          }
          group.push(next);
        }
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
  pushTurnEnd();
  return rows;
}

/**
 * Find the activity row of the running Turn: its last activity row after the
 * last message. Tasks, Thread cards, asks, and the "New" marker can follow it.
 */
export function liveActivityIndex(
  rows: readonly TranscriptListRow[],
): number | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.kind === "activity") return index;
    if (row.kind === "entry" && row.entry.kind === "message") return undefined;
  }
  return undefined;
}

function askedItemId(entry: RenderedTranscriptEntry): string | undefined {
  return entry.kind === "tool"
    ? inboxItemIdFromToolCall(entry.part)
    : undefined;
}

function isAskEntry(entry: RenderedTranscriptEntry): boolean {
  return askedItemId(entry) !== undefined;
}

/** Return the key of the last ask entry of each Inbox item. */
function lastAskEntryKeys(
  entries: readonly RenderedTranscriptEntry[],
): Set<string> {
  const keys = new Map<string, string>();
  for (const entry of entries) {
    const itemId = askedItemId(entry);
    if (itemId !== undefined) keys.set(itemId, entry.key);
  }
  return new Set(keys.values());
}

/** Find the row that records the question Junior asked with an Inbox item. */
export function askRowIndex(
  rows: readonly TranscriptListRow[],
  itemId: string,
): number | undefined {
  const index = rows.findIndex(
    (row) => row.kind === "entry" && askedItemId(row.entry) === itemId,
  );
  return index < 0 ? undefined : index;
}

function lastRowSeq(rows: readonly TranscriptListRow[]): number | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.kind !== "unread_marker" && row.seq !== undefined) return row.seq;
  }
  return undefined;
}

function isReplyEntry(entry: RenderedTranscriptEntry): boolean {
  return (
    entry.kind === "message" &&
    entry.message.role === "assistant" &&
    !entry.message.eventType &&
    !entry.message.context
  );
}

function isTaskEntry(entry: RenderedTranscriptEntry): entry is SubagentEntry {
  return entry.kind === "subagent" && entry.part.childKind === "task";
}

function isCaptureEntry(entry: RenderedTranscriptEntry): boolean {
  return entry.kind === "structured_event" && isMemoryCaptureEvent(entry.part);
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

/**
 * Find the row that shows the Turn of an event without a row, such as a
 * memory event: the last row before `seq`. A question moved after its reply
 * keeps the reply seq, so this returns the first row with that seq.
 */
export function rowIndexBeforeSeq(
  rows: readonly TranscriptListRow[],
  seq: number,
): number | undefined {
  let index: number | undefined;
  let runSeq: number | undefined;
  for (let i = rowIndexForSeq(rows, seq) - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (row.kind === "unread_marker") continue;
    if (index !== undefined && row.seq !== runSeq) break;
    index = i;
    runSeq = row.seq;
  }
  return index;
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

/** Comfortable rows pad 10px above and below, not 6px, like `TranscriptRow`. */
const COMFORTABLE_ROW_EXTRA_PX = 8;

/**
 * Guess the height of a row of a size class before any of them measure.
 * Comfortable density pads each row more, so the guess grows with it.
 */
export function defaultTranscriptRowSize(
  sizeClass: string,
  comfortable = false,
): number {
  return (
    baseTranscriptRowSize(sizeClass) +
    (comfortable ? COMFORTABLE_ROW_EXTRA_PX : 0)
  );
}

function baseTranscriptRowSize(sizeClass: string): number {
  if (sizeClass === "unread_marker") return 32;
  if (sizeClass === "activity") return 36;
  if (sizeClass === "tasks") return 36;
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
  for (const entryKey of entryKeys) {
    args.knownKeys.set(entryKey, groupKey);
  }
  return groupKey;
}

function entryTimestamp(
  entry: RenderedTranscriptEntry | undefined,
): number | undefined {
  if (!entry) return undefined;
  return entry.kind === "message" ? entry.message.timestamp : entry.timestamp;
}

function rowTimestamp(row: TranscriptListRow): number | undefined {
  if (row.kind === "unread_marker") return undefined;
  if (row.kind === "entry") return entryTimestamp(row.entry);
  return entryTimestamp(row.entries[0]);
}

/**
 * Label the first row of each calendar day: `Today`, `Yesterday`, then the
 * weekday and date. Returns labels by row index.
 */
export function transcriptDayLabels(
  rows: readonly TranscriptListRow[],
  nowMs: number,
  timeZone: string,
): Map<number, string> {
  const labels = new Map<number, string>();
  const nowDay = calendarDay(nowMs, timeZone);
  let lastDay: number | undefined;
  for (const [index, row] of rows.entries()) {
    const time = rowTimestamp(row);
    if (time === undefined) continue;
    const day = calendarDay(time, timeZone);
    if (day === lastDay) continue;
    lastDay = day;
    const days = calendarDaysAgo(time, nowDay, timeZone);
    labels.set(
      index,
      days <= 0
        ? "Today"
        : days === 1
          ? "Yesterday"
          : formatTime(time, {
              day: "numeric",
              month: "short",
              timeZone,
              weekday: "long",
            }),
    );
  }
  return labels;
}
