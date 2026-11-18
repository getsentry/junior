import type {
  AutomationListItem,
  ReviewItemPayload,
} from "@sentry/junior/api/schema";

import {
  itemNeedsViewer,
  itemStackId,
  itemUpForGrabs,
  reviewItemStatusLabel,
  type InboxBundle,
} from "./reviewItemFormat";

/**
 * The Inbox entries in the pane, as in Google Inbox. Each one names a list
 * in the main area: the Inbox, Snoozed, Done, Conversations, then the asks
 * by type.
 */
export type InboxView =
  | "conversations"
  | "decisions"
  | "done"
  | "inbox"
  | "prs"
  | "snoozed";

const INBOX_VIEWS: readonly InboxView[] = [
  "conversations",
  "decisions",
  "done",
  "inbox",
  "prs",
  "snoozed",
];

/** The list heading of each entry. The Inbox itself has no heading. */
export const INBOX_VIEW_LABELS: Record<InboxView, string> = {
  conversations: "Conversations",
  decisions: "Decisions",
  done: "Done",
  inbox: "Inbox",
  prs: "Pull requests",
  snoozed: "Snoozed",
};

/** Read the entry from `?view=`. The Inbox is the default. */
export function parseInboxView(value: string | null): InboxView {
  return INBOX_VIEWS.find((view) => view === value) ?? "inbox";
}

/** Read the entry of a list path, such as the return path of a Back. */
export function inboxViewOfPath(path: string): InboxView {
  return parseInboxView(new URLSearchParams(path.split("?")[1]).get("view"));
}

/** The list path of an entry, with one item's row expanded when given. */
export function inboxViewPath(
  view: InboxView,
  options: { itemId?: string } = {},
): string {
  const params = new URLSearchParams();
  // Phones show the entries at `/`, so an item link names its entry.
  if (view !== "inbox" || options.itemId) params.set("view", view);
  if (options.itemId) params.set("item", options.itemId);
  const search = params.toString();
  return search ? `/?${search}` : "/";
}

/** An ask or notice about a code change, such as a GitHub pull request. */
function isCodeChangeItem(item: ReviewItemPayload): boolean {
  return item.subject?.objectType === "code_change";
}

/** A question or approval that Junior asks with a form. */
function isDecisionItem(item: ReviewItemPayload): boolean {
  return Boolean(item.request);
}

/** Keep the items that one bundle holds. */
export function itemsInView(
  items: readonly ReviewItemPayload[],
  view: "decisions" | "prs",
): ReviewItemPayload[] {
  return items.filter(view === "prs" ? isCodeChangeItem : isDecisionItem);
}

/** A row for one item, as a stack or an item view shows it. */
export function singleRow(item: ReviewItemPayload): InboxBundle {
  return {
    conversationId: itemStackId(item),
    items: [item],
    key: item.id,
    needsYou: itemNeedsViewer(item),
    newest: item,
    waitingSince: item.createdAt,
  };
}

/** What waits on the viewer first, then the longest wait. */
function queueOrder(a: InboxBundle, b: InboxBundle): number {
  return (
    Number(b.needsYou) - Number(a.needsYou) ||
    Date.parse(a.waitingSince) - Date.parse(b.waitingSince) ||
    a.key.localeCompare(b.key)
  );
}

/** Build the rows of a bundle of items: one row per item, queue order. */
export function viewRows(
  items: readonly ReviewItemPayload[],
  view: "decisions" | "prs",
): InboxBundle[] {
  return itemsInView(items, view).map(singleRow).sort(queueOrder);
}

/** One labelled group of rows in the stream. */
type InboxSection = { key: string; label: string; rows: InboxBundle[] };

/** The time sections of a stream, newest first. */
export const TIME_SECTIONS = [
  { key: "today", label: "Today" },
  { key: "week", label: "This week" },
  { key: "earlier", label: "Earlier" },
] as const;

/** Put a time in Today, This week, or Earlier. */
export function timeSectionAt(iso: string, nowMs: number): string {
  const at = Date.parse(iso);
  const startOfToday = new Date(nowMs);
  startOfToday.setHours(0, 0, 0, 0);
  if (at >= startOfToday.getTime()) return "today";
  if (at >= startOfToday.getTime() - 6 * 86_400_000) return "week";
  return "earlier";
}

/** Split rows into Today, This week, and Earlier, keeping their order. */
export function timeGroups<Row>(
  rows: readonly Row[],
  timeOf: (row: Row) => string,
  nowMs: number,
) {
  return TIME_SECTIONS.map((section) => ({
    ...section,
    rows: rows.filter(
      (row) => timeSectionAt(timeOf(row), nowMs) === section.key,
    ),
  })).filter((section) => section.rows.length > 0);
}

/**
 * Group closed items for Done: Today, This week, and Earlier, by when they
 * closed, newest closed first as the list reads them. Empty groups drop out.
 */
export function doneSections(
  items: readonly ReviewItemPayload[],
  nowMs: number,
): { items: ReviewItemPayload[]; key: string; label: string }[] {
  return TIME_SECTIONS.map((section) => ({
    ...section,
    items: items.filter(
      (item) =>
        timeSectionAt(item.closedAt ?? item.updatedAt, nowMs) === section.key,
    ),
  })).filter((section) => section.items.length > 0);
}

/**
 * The state that a pull request ask names before ` · `, as plugin titles
 * such as `Review requested · #91` do. Other pull request items share one
 * group.
 */
const PULL_REQUEST_STATES = ["Review requested", "Ready to merge"] as const;

function pullRequestState(item: ReviewItemPayload): string {
  if (!isCodeChangeItem(item)) return "Other";
  const state = item.title.split(" · ")[0];
  return PULL_REQUEST_STATES.find((known) => known === state) ?? "Other";
}

/**
 * What one item is, as its row says: Question, Approval, the pull request
 * state that a plugin ask names, or FYI. A closed item says how it closed.
 */
export function inboxItemKind(item: ReviewItemPayload): string {
  if (item.status !== "open") return reviewItemStatusLabel(item);
  if (item.kind === "notice") return "FYI";
  if (item.request) return "Question";
  const state = pullRequestState(item);
  return state === "Other" ? "Approval" : state;
}

/**
 * Group rows by Conversation. The Conversation that waited longest comes
 * first, so groups do not move while the reader works.
 */
function byConversation(
  rows: readonly InboxBundle[],
  titleOf: (conversationId: string) => string | undefined,
): InboxSection[] {
  const groups = new Map<string, InboxBundle[]>();
  for (const row of rows)
    groups.set(row.conversationId, [
      ...(groups.get(row.conversationId) ?? []),
      row,
    ]);
  const oldest = (group: InboxBundle[]) =>
    Math.min(...group.map((row) => Date.parse(row.waitingSince)));
  return [...groups]
    .sort(
      ([aId, a], [bId, b]) => oldest(a) - oldest(b) || aId.localeCompare(bId),
    )
    .map(([conversationId, group]) => ({
      key: `c:${conversationId}`,
      // The rows lead with their item titles, so the heading never falls
      // back to one.
      label:
        titleOf(conversationId) ??
        group[0]!.newest.subject?.title ??
        "Untitled",
      rows: group,
    }));
}

/**
 * Group the rows of the Decisions bundle by Conversation. Empty groups drop
 * out. Pull requests group by code change instead (`pullRequestSections`).
 */
export function viewSections(
  rows: readonly InboxBundle[],
  titleOf: (conversationId: string) => string | undefined,
): InboxSection[] {
  return byConversation(rows, titleOf).filter(
    (section) => section.rows.length > 0,
  );
}

/** Why an Automation needs attention. */
type AutomationAttentionGroup =
  | "Blocked"
  | "Trigger unavailable"
  | "Last run failed or blocked";

/**
 * Say why an Automation needs attention. It mirrors the `attention` scope
 * of the Automation list: blocked, an unavailable trigger, or a last run
 * that failed or blocked.
 */
export function automationAttentionGroup(
  automation: AutomationListItem,
): AutomationAttentionGroup {
  if (automation.status === "blocked") return "Blocked";
  if (automation.kind === "event" && automation.trigger.problems.length > 0)
    return "Trigger unavailable";
  return "Last run failed or blocked";
}

/**
 * What a sweep would mark done in some rows: notices (FYI) only. Every
 * action item stays, including one assigned to Everyone, and so does every
 * item of a pinned Conversation. Automations are not Review items, so a
 * sweep never sees them.
 */
export function sweepOf(
  rows: readonly InboxBundle[],
  isPinned: (conversationId: string) => boolean,
): ReviewItemPayload[] {
  return rows
    .filter((row) => !isPinned(row.conversationId))
    .flatMap((row) => row.items)
    .filter(
      (item) => item.status === "open" && item.kind === "notice" && item.canAct,
    );
}

/**
 * The second line of a row for one item: what it is about, then its
 * Conversation. A part that repeats the item title drops out, and with no
 * part left the row has no second line.
 */
export function itemRowSubtitle(
  item: Pick<ReviewItemPayload, "subject" | "title">,
  conversationTitle: string | undefined,
): string | undefined {
  const parts = [...new Set([item.subject?.title, conversationTitle])].filter(
    (part): part is string => Boolean(part) && part !== item.title,
  );
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * The key of the row that shows an item of `bundle`: in a stack of more
 * than one ask, the item's own row; else the Conversation's row.
 */
export function stackRowKey(bundle: InboxBundle, itemId: string): string {
  return bundle.items.length > 1 ? itemId : bundle.key;
}

/**
 * The key of the Inbox row that shows a linked open item: in Up for grabs,
 * To do, or the stream, and in its stack, the item's own row.
 */
export function linkedInboxRowKey(
  item: ReviewItemPayload,
  rows: {
    grabs: readonly InboxBundle[];
    stream: readonly InboxBundle[];
    todo: readonly InboxBundle[];
  },
): string {
  const conversationId = itemStackId(item);
  const rowIn = (prefix: string, bundles: readonly InboxBundle[]) => {
    const row = bundles.find(
      (bundle) => bundle.conversationId === conversationId,
    );
    return row ? `${prefix}:${stackRowKey(row, item.id)}` : undefined;
  };
  const grab = rowIn("grabs", rows.grabs);
  return (
    (itemUpForGrabs(item) ? grab : undefined) ??
    rowIn("todo", rows.todo) ??
    grab ??
    rowIn("conversation", rows.stream) ??
    `conversation:${conversationId}`
  );
}
