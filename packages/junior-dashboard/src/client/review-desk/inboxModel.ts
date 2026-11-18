import type {
  AutomationListItem,
  ReviewItemPayload,
} from "@sentry/junior/api/schema";

import {
  itemNeedsViewer,
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
export function isCodeChangeItem(item: ReviewItemPayload): boolean {
  return item.subject?.objectType === "code_change";
}

/** A question or approval that Junior asks with a form. */
export function isDecisionItem(item: ReviewItemPayload): boolean {
  return Boolean(item.request);
}

/** Keep the items that one bundle holds. */
export function itemsInView(
  items: readonly ReviewItemPayload[],
  view: "decisions" | "prs",
): ReviewItemPayload[] {
  return items.filter(view === "prs" ? isCodeChangeItem : isDecisionItem);
}

function singleRow(item: ReviewItemPayload): InboxBundle {
  return {
    conversationId: item.addedByConversationId,
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

/**
 * Fold each open notice about the subject of an open action item into that
 * item, matched by subject id or URL, so the item's row shows it as a status
 * line. The notice stays open on its own: closing the action item does not
 * close it, and it then shows on its own again.
 */
export function foldNotices(items: readonly ReviewItemPayload[]): {
  /** The notices that fold into each action item, by the item's id. */
  folded: ReadonlyMap<string, ReviewItemPayload[]>;
  /** Every other item, in the same order. */
  shown: ReviewItemPayload[];
} {
  const subjectKeys = (item: ReviewItemPayload) =>
    [item.subject?.id, item.subject?.url].filter(
      (key): key is string => key !== undefined,
    );
  const hosts = new Map<string, ReviewItemPayload>();
  for (const item of [...items].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  )) {
    if (item.status !== "open" || item.kind !== "action") continue;
    for (const key of subjectKeys(item))
      if (!hosts.has(key)) hosts.set(key, item);
  }
  const folded = new Map<string, ReviewItemPayload[]>();
  const shown = items.filter((item) => {
    if (item.status !== "open" || item.kind !== "notice") return true;
    const host = subjectKeys(item)
      .map((key) => hosts.get(key))
      .find(Boolean);
    if (!host) return true;
    folded.set(host.id, [...(folded.get(host.id) ?? []), item]);
    return false;
  });
  return { folded, shown };
}

/**
 * The FYI list: one row per open notice, newest first. Notices wait on no
 * one, so they are not in To do.
 */
export function fyiRows(items: readonly ReviewItemPayload[]): InboxBundle[] {
  return items
    .filter((item) => item.status === "open" && item.kind === "notice")
    .map(singleRow)
    .sort(
      (a, b) =>
        Date.parse(b.waitingSince) - Date.parse(a.waitingSince) ||
        a.key.localeCompare(b.key),
    );
}

/**
 * The status line of a notice folded into an item, such as "Merge conflict".
 * The item's card already names the subject, so the reference that plugin
 * titles add after ` · ` drops out.
 */
export function foldedNoticeLabel(notice: ReviewItemPayload): string {
  return notice.title.split(" · ")[0] || notice.title;
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
 * What a sweep would dismiss in some rows: notices (FYI) only. Every
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

/** Count FYIs in words, such as "1 FYI" or "4 FYIs". */
export function fyiCount(count: number): string {
  return `${count} FYI${count === 1 ? "" : "s"}`;
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
