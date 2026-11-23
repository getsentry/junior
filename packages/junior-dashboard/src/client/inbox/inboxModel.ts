import type {
  AutomationListItem,
  InboxItemPayload,
} from "@sentry/junior/api/schema";
import type { CodeChangeSize } from "@sentry/junior-plugin-api";

import type { Conversation } from "../types";

import {
  type InboxBundle,
  inboxBundles,
  itemNeedsViewer,
  itemStackKey,
  itemUpForGrabs,
  inboxItemStatusLabel,
} from "./inboxItemFormat";

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
export function isCodeChangeItem(item: InboxItemPayload): boolean {
  return item.subject?.objectType === "code_change";
}

/** A question or approval that Junior asks with a form. */
export function isDecisionItem(item: InboxItemPayload): boolean {
  return Boolean(item.request);
}

/** Keep the items that one bundle holds. */
export function itemsInView(
  items: readonly InboxItemPayload[],
  view: "decisions" | "prs",
): InboxItemPayload[] {
  return items.filter(view === "prs" ? isCodeChangeItem : isDecisionItem);
}

/** A row for one item, as a stack or an item view shows it. */
export function singleRow(item: InboxItemPayload): InboxBundle {
  return {
    conversationId: item.rootConversationId,
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
  items: readonly InboxItemPayload[],
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
export function foldNotices(items: readonly InboxItemPayload[]): {
  /** The notices that fold into each action item, by the item's id. */
  folded: ReadonlyMap<string, InboxItemPayload[]>;
  /** Every other item, in the same order. */
  shown: InboxItemPayload[];
} {
  const subjectKeys = (item: InboxItemPayload) =>
    [item.subject?.id, item.subject?.url].filter(
      (key): key is string => key !== undefined,
    );
  const hosts = new Map<string, InboxItemPayload>();
  for (const item of [...items].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  )) {
    if (item.status !== "open" || item.kind !== "action") continue;
    for (const key of subjectKeys(item))
      if (!hosts.has(key)) hosts.set(key, item);
  }
  const folded = new Map<string, InboxItemPayload[]>();
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
 * The FYI list: the open notices, stacked by root Conversation, and the
 * stack with the newest notice first. Notices wait on no one, so they are
 * not in To do.
 */
export function fyiRows(items: readonly InboxItemPayload[]): InboxBundle[] {
  return inboxBundles(
    items.filter((item) => item.status === "open" && item.kind === "notice"),
  ).sort(
    (a, b) =>
      Date.parse(b.newest.createdAt) - Date.parse(a.newest.createdAt) ||
      a.key.localeCompare(b.key),
  );
}

/**
 * The status line of a notice folded into an item, such as "Checks failed".
 * The item's card already names the subject, so the reference that plugin
 * titles add after ` · ` drops out.
 */
export function foldedNoticeLabel(notice: InboxItemPayload): string {
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
  items: readonly InboxItemPayload[],
  nowMs: number,
): { items: InboxItemPayload[]; key: string; label: string }[] {
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

function pullRequestState(
  item: InboxItemPayload,
): (typeof PULL_REQUEST_STATES)[number] | "Other" {
  if (!isCodeChangeItem(item)) return "Other";
  const state = item.title.split(" · ")[0];
  return PULL_REQUEST_STATES.find((known) => known === state) ?? "Other";
}

// The GitHub plugin's text for each state names the pull request by its
// number only (`junior-github` `showAction`). Under a head that shows the
// state and the number, it says nothing new. Text that says more, such as
// "#91 has new commits since you requested changes.", stays.
const PULL_REQUEST_STATE_TEXT: Record<
  (typeof PULL_REQUEST_STATES)[number],
  (number: string) => string
> = {
  "Ready to merge": (number) =>
    `${number} is approved, and GitHub says that it can merge.`,
  "Review requested": (number) => `GitHub asks you to review ${number}.`,
};

/**
 * Whether an item's text only says what its row's head shows: the pull
 * request state and number of its title, as in "GitHub asks you to review
 * #91." under "Review requested · #91". `text` leaves out the subject URL.
 */
export function textRepeatsHead(item: InboxItemPayload, text: string): boolean {
  const state = pullRequestState(item);
  if (state === "Other") return false;
  const number = item.title.slice(item.title.indexOf(" · ") + 3);
  return (
    /^#\d+$/.test(number) &&
    text.trim() === PULL_REQUEST_STATE_TEXT[state](number)
  );
}

/**
 * What one item is, as its row says: Question, Approval, the pull request
 * state that a plugin ask names, or FYI. A closed item says how it closed.
 */
export function inboxItemKind(item: InboxItemPayload): string {
  if (item.status !== "open") return inboxItemStatusLabel(item);
  if (item.kind === "notice") return "FYI";
  if (item.request) return "Question";
  const state = pullRequestState(item);
  return state === "Other" ? "Approval" : state;
}

/**
 * Group rows by Conversation, or by another owner's stack. The group that
 * waited longest comes first, so groups do not move while the reader works.
 */
function byConversation(
  rows: readonly InboxBundle[],
  titleOf: (conversationId: string | undefined) => string | undefined,
): InboxSection[] {
  const groups = new Map<string, InboxBundle[]>();
  for (const row of rows) {
    const key = itemStackKey(row.newest);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const oldest = (group: InboxBundle[]) =>
    Math.min(...group.map((row) => Date.parse(row.waitingSince)));
  return [...groups]
    .sort(
      ([aId, a], [bId, b]) => oldest(a) - oldest(b) || aId.localeCompare(bId),
    )
    .map(([key, group]) => ({
      key: `c:${key}`,
      // The rows lead with their item titles, so the heading never falls
      // back to one.
      label:
        titleOf(group[0]!.conversationId) ??
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
  titleOf: (conversationId: string | undefined) => string | undefined,
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
 * item of a pinned Conversation. An Automation alert is an action item, so
 * it stays too.
 */
export function sweepOf(
  rows: readonly InboxBundle[],
  isPinned: (conversationId: string | undefined) => boolean,
): InboxItemPayload[] {
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
 * part left the row has no second line. A subject that ends with what the
 * title says, as "Fix it (#12)" under "Review requested · #12", drops that
 * end.
 */
export function itemRowSubtitle(
  item: Pick<InboxItemPayload, "subject" | "title">,
  conversationTitle: string | undefined,
): string | undefined {
  const subject = item.subject?.title;
  const tail = subject ? / \(([^()]+)\)$/.exec(subject) : null;
  const about =
    subject && tail && item.title.includes(tail[1]!)
      ? subject.slice(0, tail.index)
      : subject;
  const parts = [...new Set([about, conversationTitle])].filter(
    (part): part is string => Boolean(part) && part !== item.title,
  );
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * The size of the code change that an item is about, as its Conversation's
 * linked work saved it. Undefined when that work has no size.
 */
export function subjectSize(
  item: Pick<InboxItemPayload, "subject">,
  conversation: Pick<Conversation, "sidebarAnnotations"> | undefined,
): CodeChangeSize | undefined {
  const url = item.subject?.url;
  if (!url) return undefined;
  return conversation?.sidebarAnnotations?.find(
    (annotation) => annotation.url === url,
  )?.size;
}

/**
 * Where an item sits, for a row on its own: its root's title, then the
 * sub-thread that added it, as "Triage deploys › Read the agent logs".
 */
export function childOf(
  rootTitle: string | undefined,
  item: Pick<InboxItemPayload, "addedByLabel">,
): string | undefined {
  const child = item.addedByLabel;
  if (!child || !rootTitle || child === rootTitle) return child ?? rootTitle;
  return `${rootTitle} › ${child}`;
}

/**
 * The key of the Inbox row that shows a linked open item: its own row, in
 * Up for grabs or To do. The Inbox lists no Conversations, so an item in
 * neither has no row here.
 */
function linkedInboxRowKey(
  item: InboxItemPayload,
  rows: { grabs: readonly InboxBundle[]; todo: readonly InboxBundle[] },
): string | undefined {
  const rowIn = (prefix: string, bundles: readonly InboxBundle[]) =>
    bundles.some((bundle) => itemStackKey(bundle.newest) === itemStackKey(item))
      ? `${prefix}:${item.id}`
      : undefined;
  const grab = rowIn("grabs", rows.grabs);
  return (
    (itemUpForGrabs(item) ? grab : undefined) ??
    rowIn("todo", rows.todo) ??
    grab
  );
}

/**
 * The row that a link to one item opens in a list, and the open item that
 * the row shows. A snoozed item opens its row in Snoozed. A notice folded
 * into an ask opens the ask's row.
 */
export function linkedRowOf(
  view: InboxView,
  linkedId: string | undefined,
  rows: {
    awake: readonly InboxItemPayload[];
    done: readonly InboxItemPayload[];
    foldedNotices: ReadonlyMap<string, readonly InboxItemPayload[]>;
    grabs: readonly InboxBundle[];
    snoozed: readonly InboxBundle[];
    todo: readonly InboxBundle[];
  },
): {
  key?: string;
  open?: InboxItemPayload;
  rowItemId?: string;
  snoozedKey?: string;
} {
  if (!linkedId) return {};
  // A notice folded into an ask's row opens that row, awake or snoozed.
  const hostId = [...rows.foldedNotices].find(([, notices]) =>
    notices.some((notice) => notice.id === linkedId),
  )?.[0];
  const rowItemId = hostId ?? linkedId;
  const snoozedRow = rows.snoozed.find((row) =>
    row.items.some((item) => item.id === rowItemId),
  );
  const snoozedKey = snoozedRow ? rowItemId : undefined;
  const open = rows.awake.find((item) => item.id === rowItemId);
  const key = (() => {
    if (view === "snoozed") return snoozedKey;
    if (view === "done")
      return rows.done.some((item) => item.id === linkedId)
        ? linkedId
        : undefined;
    if (!open) return undefined;
    if (view === "prs" || view === "decisions") return open.id;
    if (view !== "inbox") return `conversation:${open.rootConversationId}`;
    if (open.kind === "notice") return `fyi:${open.id}`;
    return linkedInboxRowKey(open, rows);
  })();
  return { key, open, rowItemId, snoozedKey };
}
