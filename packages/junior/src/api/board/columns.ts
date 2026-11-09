/**
 * Board column rules. The Board is an experiment that uses only stored
 * records, so these rules guess at stage from facts that exist for other
 * reasons. Each guess is named here, so a real stage field can replace it:
 *
 * 1. Ready means an open plugin notice on the review desk has the code change
 *    as its subject. The GitHub plugin adds a "Ready to merge" notice and
 *    closes it when the pull request merges or stops being ready.
 * 2. A ticket is `open` or `closed`. Other provider states are not known, so
 *    those tickets are not on the Board.
 * 3. A closed ticket finished when its annotation last changed.
 * 4. An open ticket is in progress while its Conversation runs a Turn.
 *
 * Each function returns one column or none, and each object gives one card,
 * so a card cannot be in two columns.
 */
import type { BoardColumn } from "../schema/board";

/** Hours that a finished card stays in Done. */
export const BOARD_DONE_WINDOW_HOURS = 6;

const DONE_WINDOW_MS = BOARD_DONE_WINDOW_HOURS * 60 * 60 * 1_000;

/** Choose the column of a code change that Junior created. */
export function codeChangeColumn(args: {
  hasReadyNotice: boolean;
  mergedAtMs?: number;
  nowMs: number;
  state: "open" | "merged" | "closed";
}): BoardColumn | undefined {
  if (args.state === "merged") {
    return args.mergedAtMs !== undefined &&
      args.nowMs - args.mergedAtMs <= DONE_WINDOW_MS
      ? "done"
      : undefined;
  }
  // A code change closed without a merge did not finish the work.
  if (args.state === "closed") return undefined;
  return args.hasReadyNotice ? "ready" : "in_progress";
}

/** Choose the column of a ticket linked to a Conversation. */
export function ticketColumn(args: {
  nowMs: number;
  status: string;
  updatedAtMs: number;
  working: boolean;
}): BoardColumn | undefined {
  if (args.status === "closed") {
    return args.nowMs - args.updatedAtMs <= DONE_WINDOW_MS ? "done" : undefined;
  }
  if (args.status !== "open") return undefined;
  return args.working ? "in_progress" : "planned";
}
