import type {
  AutomationSummary,
  ReviewItemPayload,
} from "@sentry/junior/api/schema";

import {
  inboxBundles,
  itemNeedsViewer,
  reviewItemStatusLabel,
  type InboxBundle,
} from "./reviewItemFormat";

/**
 * The inbox bundles, as in Google Inbox. Every bundle is automatic: All,
 * pull requests, decisions, Automations that need attention, then one per
 * Conversation. `needs-you` is the landing view that other pages link to.
 */
export type InboxView =
  | "all"
  | "automations"
  | "decisions"
  | "needs-you"
  | "prs"
  | `c:${string}`;

/**
 * Read the bundle from the URL. `bundle` names a bundle in the list, and
 * `filter=needs-you` opens the items that wait on the viewer. The inbox
 * opens on All.
 */
export function parseInboxView(params: URLSearchParams): InboxView {
  if (params.get("filter") === "needs-you") return "needs-you";
  const value = params.get("bundle");
  if (value === "prs" || value === "decisions" || value === "automations")
    return value;
  if (value?.startsWith("c:") && value.length > 2) return value as InboxView;
  return "all";
}

/** The bundle for one Conversation. */
export function conversationView(conversationId: string): InboxView {
  return `c:${conversationId}`;
}

/** The Conversation that a Conversation bundle shows. */
export function viewConversationId(view: InboxView): string | undefined {
  return view.startsWith("c:") ? view.slice(2) : undefined;
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
  view: InboxView,
): ReviewItemPayload[] {
  if (view === "all") return [...items];
  if (view === "prs") return items.filter(isPullRequestItem);
  if (view === "decisions") return items.filter(isDecisionItem);
  if (view === "needs-you") return items.filter(itemNeedsViewer);
  // Automation attention comes from the Automation list, not Review items.
  if (view === "automations") return [];
  const id = view.slice(2);
  return items.filter((item) => item.addedByConversationId === id);
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

/**
 * Build the rows of one bundle. All shows one collapsed row per
 * Conversation. A narrower bundle shows one row per item.
 */
export function viewRows(
  items: readonly ReviewItemPayload[],
  view: InboxView,
): InboxBundle[] {
  const inView = itemsInView(items, view);
  if (view === "all") return inboxBundles(inView);
  return inView.map(singleRow).sort(queueOrder);
}

/** One labelled group of rows in the stream. */
type InboxSection = { key: string; label: string; rows: InboxBundle[] };

const TIME_SECTIONS = [
  { key: "today", label: "Today" },
  { key: "week", label: "This week" },
  { key: "earlier", label: "Earlier" },
] as const;

/**
 * Put a row in Today, This week, or Earlier, by how long it has waited, so
 * new activity on an old ask does not move it up.
 */
function timeSectionOf(row: InboxBundle, nowMs: number): string {
  const at = Date.parse(row.waitingSince);
  const startOfToday = new Date(nowMs);
  startOfToday.setHours(0, 0, 0, 0);
  if (at >= startOfToday.getTime()) return "today";
  if (at >= startOfToday.getTime() - 6 * 86_400_000) return "week";
  return "earlier";
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
function inboxItemKind(item: ReviewItemPayload): string {
  if (item.status !== "open") return reviewItemStatusLabel(item);
  if (item.kind === "notice") return "FYI";
  if (item.request) return "Question";
  const state = pullRequestState(item);
  return state === "Other" ? "Approval" : state;
}

const COUNTED_KINDS: Record<string, string> = {
  Approval: "approvals",
  Question: "questions",
};

/**
 * Say in one short line what a row holds, after the newest item's title. A
 * row counts its kinds, as in `2 questions · Review requested · FYI`. The
 * newest item does not count when its title already starts with its kind,
 * as in `Ready to merge · #42`.
 */
export function inboxRowReason(bundle: InboxBundle): string | undefined {
  const counts = new Map<string, number>();
  for (const item of bundle.items) {
    const kind = inboxItemKind(item);
    if (item === bundle.newest && item.title.startsWith(kind)) continue;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  if (counts.size === 0) return undefined;
  if (bundle.items.length === 1) return [...counts.keys()][0];
  return [...counts]
    .map(([kind, count]) => {
      const plural = COUNTED_KINDS[kind];
      if (plural)
        return `${count} ${count === 1 ? kind.toLowerCase() : plural}`;
      return count === 1 || kind === "FYI" ? kind : `${kind} (${count})`;
    })
    .join(" · ");
}

/** Item kinds in a Conversation bundle, in stream order. */
const ITEM_KINDS = ["Decisions", "Pull requests", "Asks", "Notices"] as const;

function itemKind(item: ReviewItemPayload): (typeof ITEM_KINDS)[number] {
  if (isDecisionItem(item)) return "Decisions";
  if (isPullRequestItem(item)) return "Pull requests";
  return item.kind === "notice" ? "Notices" : "Asks";
}

/** Group rows by a fixed list of labels, in that order. */
function byLabels(
  rows: readonly InboxBundle[],
  labels: readonly string[],
  labelOf: (row: InboxBundle) => string,
): InboxSection[] {
  return labels.map((label) => ({
    key: label,
    label,
    rows: rows.filter((row) => labelOf(row) === label),
  }));
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
 * Group the rows of a bundle the way its filter reads best. All leads with
 * what waits on the viewer (To do), longest wait first, then Today, This week, and
 * Earlier. Pull requests group by state, decisions and the needs-you view by
 * Conversation, and one Conversation by item kind. Empty groups drop out.
 */
export function viewSections(
  view: InboxView,
  rows: readonly InboxBundle[],
  options: {
    nowMs: number;
    titleOf(conversationId: string): string | undefined;
  },
): InboxSection[] {
  const sections =
    view === "all"
      ? [
          {
            key: "todo",
            label: "To do",
            rows: rows.filter((row) => row.needsYou),
          },
          ...TIME_SECTIONS.map((section) => ({
            ...section,
            rows: rows.filter(
              (row) =>
                !row.needsYou &&
                timeSectionOf(row, options.nowMs) === section.key,
            ),
          })),
        ]
      : view === "prs"
        ? byLabels(rows, [...PULL_REQUEST_STATES, "Other"], (row) =>
            pullRequestState(row.newest),
          )
        : view === "decisions" || view === "needs-you"
          ? byConversation(rows, options.titleOf)
          : view === "automations"
            ? []
            : byLabels(rows, ITEM_KINDS, (row) => itemKind(row.newest));
  return sections.filter((section) => section.rows.length > 0);
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
 * What a sweep would mark done in some rows. A sweep clears notices and FYI
 * items only. Items that wait on the viewer stay, and so do pinned items.
 * Automations are not Review items, so a sweep never sees them.
 */
export function sweepOf(
  rows: readonly InboxBundle[],
  isPinned: (item: ReviewItemPayload) => boolean,
): ReviewItemPayload[] {
  return rows
    .flatMap((row) => row.items)
    .filter(
      (item) =>
        item.status === "open" &&
        item.canAct &&
        !itemNeedsViewer(item) &&
        !isPinned(item),
    );
}
