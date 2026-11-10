import type { ReviewItemPayload } from "@sentry/junior/api/schema";

import {
  inboxBundles,
  itemNeedsViewer,
  type InboxBundle,
} from "./reviewItemFormat";

/**
 * The inbox bundles, as in Google Inbox. Every bundle is automatic: All,
 * pull requests, decisions, Automations that need attention, then one per
 * Conversation. Nothing is tagged by hand.
 */
export type InboxView =
  | "all"
  | "automations"
  | "prs"
  | "decisions"
  | `c:${string}`;

/** Read the bundle from the `bundle` search param. The inbox opens on All. */
export function parseInboxView(value: string | null): InboxView {
  if (value === "prs" || value === "decisions" || value === "automations")
    return value;
  if (value?.startsWith("c:") && value.length > 2) return value as InboxView;
  return "all";
}

/** The bundle for one Conversation. */
export function conversationView(conversationId: string): InboxView {
  return `c:${conversationId}`;
}

/** A pull request ask or notice from a plugin, such as GitHub. */
export function isPullRequestItem(item: ReviewItemPayload): boolean {
  return Boolean(item.subject?.url && /\/pull\/\d+/.test(item.subject.url));
}

/** A question or approval that Junior asks with a form. */
export function isDecisionItem(item: ReviewItemPayload): boolean {
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

/**
 * Build the rows of one bundle. All shows one collapsed row per
 * Conversation, as #3036 does. A narrower bundle shows one row per item, so
 * each item sits in its own time section.
 */
export function viewRows(
  items: readonly ReviewItemPayload[],
  view: InboxView,
): InboxBundle[] {
  const inView = itemsInView(items, view);
  if (view === "all") return inboxBundles(inView);
  return inView
    .map(singleRow)
    .sort(
      (a, b) =>
        Number(b.needsYou) - Number(a.needsYou) ||
        Date.parse(a.waitingSince) - Date.parse(b.waitingSince) ||
        a.key.localeCompare(b.key),
    );
}

export type TimeSection = "today" | "week" | "earlier";

export const TIME_SECTIONS: readonly { key: TimeSection; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "week", label: "This week" },
  { key: "earlier", label: "Earlier" },
];

/**
 * Put a row in Today, This week, or Earlier, by how long it has waited, so
 * new activity on an old ask does not move it up.
 */
export function timeSectionOf(row: InboxBundle, nowMs: number): TimeSection {
  const at = Date.parse(row.waitingSince);
  const startOfToday = new Date(nowMs);
  startOfToday.setHours(0, 0, 0, 0);
  if (at >= startOfToday.getTime()) return "today";
  if (at >= startOfToday.getTime() - 6 * 86_400_000) return "week";
  return "earlier";
}

/**
 * What a sweep would mark done in some rows, and what it leaves. A sweep
 * clears notices and FYI items only. Open questions and approvals that
 * block an agent stay, and so do pinned items.
 */
export function sweepOf(
  rows: readonly InboxBundle[],
  isPinned: (item: ReviewItemPayload) => boolean,
): { clear: ReviewItemPayload[]; needYou: number } {
  const items = rows.flatMap((row) => row.items);
  return {
    clear: items.filter(
      (item) =>
        item.status === "open" &&
        item.canAct &&
        !itemNeedsViewer(item) &&
        !isPinned(item),
    ),
    needYou: items.filter(itemNeedsViewer).length,
  };
}
