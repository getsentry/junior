import { parsePath } from "react-router";
import {
  INBOX_VIEW_LABELS,
  inboxViewOfPath,
  inboxViewPath,
  parseInboxView,
  type InboxView,
} from "../../inbox/inboxModel";
import { COMPOSER_PATH } from "../../conversations/conversationRoutes";
import type { DashboardHeaderNavItem } from "../../shell/components/layout/DashboardHeader";
import { NAV_PAGES } from "../../navPages";
import { LEAD_NAV_KEY } from "../../shell/primaryNav";

/**
 * A row of the pane's destinations that keeps its place: an Inbox view,
 * Code, Automations, the Lead, or a primary plugin page (its nav item key).
 */
export type PaneRow = InboxView | "automations" | "code" | (string & {});

/** The list that opened a Conversation: an Inbox view, or Code. */
export type ConversationOrigin = InboxView | "code";

/** A row shows the page, or the list that opened it. */
export type PaneRowMark = "page" | "origin";

const INBOX_PATH = inboxViewPath("inbox");

const under = (pathname: string, root: string) =>
  pathname === root || pathname.startsWith(`${root}/`);

/** True for the Inbox's own rows, which share one workspace. */
export const isInboxView = (row: PaneRow | undefined): row is InboxView =>
  row !== undefined && Object.hasOwn(INBOX_VIEW_LABELS, row);

/** True for a path, with or without its search, on a Code page. */
export function isCodePath(path: string): boolean {
  return under(parsePath(path).pathname ?? "/", NAV_PAGES.code.to);
}

/** Name the list that a return path opens: Code or an Inbox view. */
export function returnPathLabel(path: string): string {
  return isCodePath(path) ? "Code" : INBOX_VIEW_LABELS[inboxViewOfPath(path)];
}

/** True for a row that can open a Conversation and stay its origin. */
export const isConversationOrigin = (
  row: PaneRow | undefined,
): row is ConversationOrigin => row === "code" || isInboxView(row);

/**
 * True for the old Automations bundle links, `/?view=automations` and
 * `/review?bundle=automations`, which redirect to /automations.
 */
export function isOldAutomationsPath(location: {
  pathname: string;
  search: string;
}): boolean {
  const params = new URLSearchParams(location.search);
  return (
    (location.pathname === "/" && params.get("view") === "automations") ||
    (location.pathname === "/review" && params.get("bundle") === "automations")
  );
}

/**
 * True for the old Pull requests links, `/?view=prs` and
 * `/review?bundle=prs`, which redirect to Code.
 */
export function isOldPullRequestsPath(location: {
  pathname: string;
  search: string;
}): boolean {
  const params = new URLSearchParams(location.search);
  return (
    (location.pathname === "/" && params.get("view") === "prs") ||
    (location.pathname === "/review" && params.get("bundle") === "prs")
  );
}

/**
 * Where an old Pull requests link goes: the ask it names, with its snooze
 * link kept, or Code, which opens on Mine.
 */
export function oldPullRequestsTarget(search: string): string {
  const params = new URLSearchParams(search);
  const itemId = params.get("item");
  if (!itemId) return NAV_PAGES.code.to;
  return inboxViewPath("inbox", {
    itemId,
    snooze: Boolean(params.get("snooze")),
  });
}

/** True when a path opens the Lead, the Lead nav item's page. */
export function isLeadPath(
  pathname: string,
  navItems: readonly DashboardHeaderNavItem[],
): boolean {
  const lead = navItems.find((item) => item.key === LEAD_NAV_KEY);
  return lead !== undefined && pathname === lead.to;
}

/** Name the part of the destinations that a path is in, if any. */
export function paneDestinationForPath(
  pathname: string,
): "automations" | "inbox" | undefined {
  // The Lead, at `/`, heads the Inbox's destinations.
  if (
    pathname === "/" ||
    pathname === INBOX_PATH ||
    under(pathname, "/conversations")
  )
    return "inbox";
  if (under(pathname, "/automations")) return "automations";
  return undefined;
}

/**
 * Name the row that owns a path. A Conversation belongs to `origin`, the
 * list that opened it, so that list reopens it; one with no origin, such as
 * a direct link, belongs to Conversations.
 */
export function paneRowForPath(
  location: { pathname: string; search: string },
  navItems: readonly DashboardHeaderNavItem[],
  origin: ConversationOrigin | undefined,
): PaneRow | undefined {
  const { pathname } = location;
  if (isOldAutomationsPath(location)) return "automations";
  if (isOldPullRequestsPath(location) || isCodePath(pathname)) return "code";
  if (pathname === INBOX_PATH)
    return parseInboxView(new URLSearchParams(location.search).get("view"));
  // The Lead is home, with its own row.
  if (isLeadPath(pathname, navItems)) return LEAD_NAV_KEY;
  if (under(pathname, "/conversations")) return origin ?? "conversations";
  if (under(pathname, "/automations")) return "automations";
  return navItems.find(
    (item) => item.to.startsWith("/plugins/") && under(pathname, item.to),
  )?.key;
}

/**
 * How the row that owns a path marks it. On a Conversation page, a row
 * other than the Lead's is the list that opened it, not the page: the
 * Conversation's own row, such as its In flight row, marks the page. The
 * composer is no Conversation yet, so its row marks the page.
 */
export function paneRowMark(pathname: string, row: PaneRow): PaneRowMark {
  return row !== LEAD_NAV_KEY &&
    pathname !== COMPOSER_PATH &&
    under(pathname, "/conversations")
    ? "origin"
    : "page";
}

/** Where a row opens when it has no place yet, or when it shows now. */
export function paneRowRoot(
  row: PaneRow,
  navItems: readonly DashboardHeaderNavItem[],
): string {
  if (isInboxView(row)) return inboxViewPath(row);
  if (row === "automations") return "/automations";
  if (row === "code") return NAV_PAGES.code.to;
  return navItems.find((item) => item.key === row)?.to ?? "/";
}

/** The name of a row, for the way back to it. */
export function paneRowLabel(
  row: PaneRow,
  navItems: readonly DashboardHeaderNavItem[],
): string {
  if (isInboxView(row)) return INBOX_VIEW_LABELS[row];
  if (row === "automations") return "Automations";
  if (row === "code") return "Code";
  return navItems.find((item) => item.key === row)?.label ?? "Inbox";
}
