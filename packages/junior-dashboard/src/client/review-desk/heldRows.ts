import type { ConversationRow } from "./inboxData";

/**
 * Where each Inbox row showed, by Conversation, when the pointer came onto
 * the list, and the time that placed it in its section.
 */
export type RowPlaces = ReadonlyMap<string, { index: number; time: string }>;

/**
 * Note where each row shows now, to hold it there. Pins are left out: the
 * reader orders them, so a pin, an unpin or a drag shows at once.
 */
export function rowPlaces(rows: readonly ConversationRow[]): RowPlaces {
  return new Map(
    rows.flatMap((row, index) =>
      row.conversation?.pinnedAt
        ? []
        : [[row.conversationId, { index, time: row.time }] as const],
    ),
  );
}

/**
 * Keep rows where the reader saw them while the pointer is on the list, as
 * `useHeldListOrder` does for the current UI's sidebar, so
 * a feed refresh that re-sorts them moves no row under the pointer. A held
 * row keeps its place and its time, so it stays in its section, with fresh
 * content. A row that the refresh adds takes its own place among them, and
 * a row that it removes goes.
 */
export function heldRows(
  rows: readonly ConversationRow[],
  held: RowPlaces | undefined,
): readonly ConversationRow[] {
  if (!held) return rows;
  const place = (row: ConversationRow) =>
    row.conversation?.pinnedAt ? undefined : held.get(row.conversationId);
  const seen = rows
    .flatMap((row) => {
      const at = place(row);
      return at ? [{ at, row: { ...row, time: at.time } }] : [];
    })
    .sort((left, right) => left.at.index - right.at.index);
  // The held rows fill the places that held rows take now, in the order
  // the reader saw them.
  let next = 0;
  return rows.map((row) => (place(row) ? seen[next++]!.row : row));
}
