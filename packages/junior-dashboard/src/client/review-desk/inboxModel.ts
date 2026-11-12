import type {
  AutomationSummary,
  ReviewItemPayload,
} from "@sentry/junior/api/schema";

import {
  itemNeedsViewer,
  reviewItemStatusLabel,
  type InboxBundle,
} from "./reviewItemFormat";

/**
 * The entries of the Inbox sidebar, as in Google Inbox. Each one names a
 * list in the main area: the Inbox, Snoozed, Done, then the automatic
 * bundles.
 */
export type InboxView =
  | "automations"
  | "conversations"
  | "decisions"
  | "done"
  | "inbox"
  | "prs"
  | "snoozed";

const INBOX_VIEWS: readonly InboxView[] = [
  "automations",
  "conversations",
  "decisions",
  "done",
  "inbox",
  "prs",
  "snoozed",
];

/** The list heading of each entry. The Inbox itself has no heading. */
export const INBOX_VIEW_LABELS: Record<InboxView, string> = {
  automations: "Automations",
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

/** A pull request ask or notice from a plugin, such as GitHub. */
function isPullRequestItem(item: ReviewItemPayload): boolean {
  return Boolean(item.subject?.url && /\/pull\/\d+/.test(item.subject.url));
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
  return items.filter(view === "prs" ? isPullRequestItem : isDecisionItem);
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
      label: titleOf(conversationId) ?? group[0]!.newest.title,
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

/** Why an Automation needs attention, as the Automations bundle groups it. */
type AutomationAttentionGroup =
  | "Blocked"
  | "Trigger unavailable"
  | "Last run failed or blocked";

const AUTOMATION_GROUPS: readonly AutomationAttentionGroup[] = [
  "Blocked",
  "Trigger unavailable",
  "Last run failed or blocked",
];

/**
 * Say why an Automation needs attention. It mirrors the `attention` scope
 * of the Automation list: blocked, an unavailable trigger, or a last run
 * that failed or blocked.
 */
export function automationAttentionGroup(
  automation: AutomationSummary,
): AutomationAttentionGroup {
  if (automation.status === "blocked") return "Blocked";
  if (automation.kind === "event" && automation.trigger.problems.length > 0)
    return "Trigger unavailable";
  return "Last run failed or blocked";
}

/** Group Automations by why they need attention, in a fixed order. */
export function automationSections(
  automations: readonly AutomationSummary[],
): { label: AutomationAttentionGroup; automations: AutomationSummary[] }[] {
  return AUTOMATION_GROUPS.map((label) => ({
    automations: automations.filter(
      (automation) => automationAttentionGroup(automation) === label,
    ),
    label,
  })).filter((section) => section.automations.length > 0);
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
