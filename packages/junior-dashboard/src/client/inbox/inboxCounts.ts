import type { InboxItemPayload } from "@sentry/junior/api/schema";

import { askTypeOf, type AskType, type InboxTypeFilter } from "./inboxFilters";
import { isCodeChangeItem, isDecisionItem, isTodoItem } from "./inboxModel";
import { itemNeedsViewer } from "./inboxItemFormat";

/** The server counts of the items that wait on the viewer, on every page. */
type WaitingCounts = {
  codeChanges: number;
  decisions: number;
  needsViewer: number;
  todos: number;
};

/** The counts of the asks in To do: every one, and each type's. */
export type TodoCounts = Partial<Record<InboxTypeFilter, number>>;

/**
 * Count the asks in To do, and each type's, from the rows that To do shows,
 * so a badge and its list cannot drift. `design/inbox.md` owns the counting
 * rule. The rows hold only the loaded pages: while the last loaded item still
 * waits on the viewer, the server counts the asks not loaded yet, and each
 * adds one until it loads. Returns no count that is not known yet.
 */
export function inboxCounts(input: {
  /** More pages of open items follow the loaded ones. */
  hasMore: boolean;
  /** Every open item that the list knows, also a linked or held one. */
  known: readonly InboxItemPayload[];
  /** The loaded pages of open items, in the list's order: what waits first. */
  loaded: readonly InboxItemPayload[] | undefined;
  server: WaitingCounts | undefined;
  /** The asks that To do shows. */
  todo: readonly InboxItemPayload[];
}): TodoCounts {
  const { loaded, server, todo } = input;
  if (!loaded) return {};
  const shown = (type: AskType) =>
    todo.filter((item) => askTypeOf(item) === type).length;
  const last = loaded.at(-1);
  if (!input.hasMore || !last || !itemNeedsViewer(last)) {
    return {
      all: todo.length,
      decisions: shown("decisions"),
      other: shown("other"),
      prs: shown("prs"),
      todos: shown("todos"),
    };
  }
  if (!server) return {};
  // The waiting items past the loaded pages that the server counts.
  const waiting = input.known.filter(itemNeedsViewer);
  const past = (
    counted: number,
    inCount: (item: InboxItemPayload) => boolean,
  ) => Math.max(0, counted - waiting.filter(inCount).length);
  const all = todo.length + past(server.needsViewer, () => true);
  const prs = shown("prs") + past(server.codeChanges, isCodeChangeItem);
  const todos = shown("todos") + past(server.todos, isTodoItem);
  // The server counts a pull request ask with a form in both, so
  // Decisions takes no more than Pull requests, To-dos, and the Other asks
  // that To do shows leave. Other keeps at least the asks that To do shows.
  const decisions = Math.max(
    shown("decisions"),
    Math.min(
      all - prs - todos - shown("other"),
      shown("decisions") + past(server.decisions, isDecisionItem),
    ),
  );
  return {
    all,
    decisions,
    other: Math.max(0, all - prs - decisions - todos),
    prs,
    todos,
  };
}
