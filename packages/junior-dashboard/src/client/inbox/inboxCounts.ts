import type { InboxItemPayload } from "@sentry/junior/api/schema";

import { isCodeChangeItem, isDecisionItem } from "./inboxModel";
import { itemNeedsViewer } from "./inboxItemFormat";

/** The server counts of the items that wait on the viewer, on every page. */
type WaitingCounts = {
  codeChanges: number;
  decisions: number;
  needsViewer: number;
};

/** What each page shows now, as the counting rule below counts it. */
type ShownRows = {
  /** The question rows that Decisions lists. */
  decisions: number;
  /** The entries under Waiting on you in Pull requests. */
  prs: number;
  /** The rows in To do. */
  todo: number;
};

/**
 * Count each Inbox badge from the rows that its page shows, so a badge and
 * its page cannot drift.
 *
 * The counting rule: a badge counts what the viewer can act on now on that
 * page, the way the page shows it, and nothing else.
 *
 * - To do (the Inbox entry, the header, the tab, and the To do heading):
 *   each row in To do. That is one row per ask that waits on the viewer, as
 *   a stack shows a row for each of its asks. An Automation alert is an
 *   ask too.
 * - Decisions: each question row that Decisions lists, also a question for
 *   Everyone.
 * - Pull requests: each entry under Waiting on you, one per pull request.
 *   Waiting on others and Drafts do not count.
 *
 * An answered, dismissed, or closed item is in no row, and a snoozed or
 * cleared row is not on the page, so none of them count.
 *
 * The rows hold only the loaded pages. The list loads what waits on the
 * viewer first, so while the last loaded item still waits, more can follow:
 * the server counts those, and each one adds one to the badge until it loads.
 * Returns undefined for a count that is not known yet.
 */
export function inboxCounts(input: {
  /** More pages of open items follow the loaded ones. */
  hasMore: boolean;
  /** Every open item that the list knows, also a linked or held one. */
  known: readonly InboxItemPayload[];
  /** The loaded pages of open items, in the list's order: what waits first. */
  loaded: readonly InboxItemPayload[] | undefined;
  rows: ShownRows;
  server: WaitingCounts | undefined;
}): Partial<Record<keyof ShownRows, number>> {
  const { loaded, rows, server } = input;
  if (!loaded) return {};
  const last = loaded.at(-1);
  const complete = !input.hasMore || !last || !itemNeedsViewer(last);
  const waiting = input.known.filter(itemNeedsViewer);
  // The waiting items past the loaded pages that a page holds.
  const past = (
    counted: (counts: WaitingCounts) => number,
    inPage: (item: InboxItemPayload) => boolean,
  ) => {
    if (complete) return 0;
    if (!server) return undefined;
    return Math.max(0, counted(server) - waiting.filter(inPage).length);
  };
  const add = (shown: number, more: number | undefined) =>
    more === undefined ? undefined : shown + more;
  const todoItems = past(
    (counts) => counts.needsViewer,
    () => true,
  );
  return {
    decisions: add(
      rows.decisions,
      past((counts) => counts.decisions, isDecisionItem),
    ),
    prs: add(
      rows.prs,
      past((counts) => counts.codeChanges, isCodeChangeItem),
    ),
    todo: add(rows.todo, todoItems),
  };
}
