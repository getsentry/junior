import {
  INBOX_VIEW_LABELS,
  inboxViewPath,
  parseInboxView,
  type InboxView,
} from "../../review-desk/inboxModel";
import type { DashboardHeaderNavItem } from "./DashboardHeader";

/**
 * A row of the pane's destinations that keeps its place: an Inbox view,
 * Automations, or a primary plugin page (its nav item key).
 */
export type PaneRow = InboxView | "automations" | (string & {});

const under = (pathname: string, root: string) =>
  pathname === root || pathname.startsWith(`${root}/`);

/** True for the Inbox's own rows, which share one workspace. */
export const isInboxView = (row: PaneRow | undefined): row is InboxView =>
  row !== undefined && Object.hasOwn(INBOX_VIEW_LABELS, row);

/** Name the part of the destinations that a path is in, if any. */
export function paneDestinationForPath(
  pathname: string,
): "automations" | "inbox" | undefined {
  if (pathname === "/" || under(pathname, "/conversations")) return "inbox";
  if (under(pathname, "/automations")) return "automations";
  return undefined;
}

/**
 * Name the row that owns a path. A Conversation belongs to the Inbox view
 * that opened it, so that view reopens it; one opened from elsewhere
 * belongs to Conversations.
 */
export function paneRowForPath(
  location: { pathname: string; search: string },
  navItems: readonly DashboardHeaderNavItem[],
  previous: PaneRow | undefined,
): PaneRow | undefined {
  const { pathname } = location;
  if (pathname === "/")
    return parseInboxView(new URLSearchParams(location.search).get("view"));
  if (under(pathname, "/conversations"))
    return isInboxView(previous) ? previous : "conversations";
  if (under(pathname, "/automations")) return "automations";
  return navItems.find(
    (item) => item.to.startsWith("/plugins/") && under(pathname, item.to),
  )?.key;
}

/** Where a row opens when it has no place yet, or when it shows now. */
export function paneRowRoot(
  row: PaneRow,
  navItems: readonly DashboardHeaderNavItem[],
): string {
  if (isInboxView(row)) return inboxViewPath(row);
  if (row === "automations") return "/automations";
  return navItems.find((item) => item.key === row)?.to ?? "/";
}

/** The name of a row, for the way back to it. */
export function paneRowLabel(
  row: PaneRow,
  navItems: readonly DashboardHeaderNavItem[],
): string {
  if (isInboxView(row)) return INBOX_VIEW_LABELS[row];
  if (row === "automations") return "Automations";
  return navItems.find((item) => item.key === row)?.label ?? "Inbox";
}
