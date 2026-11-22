import {
  INBOX_VIEW_LABELS,
  inboxViewPath,
  parseInboxView,
  type InboxView,
} from "../../inbox/inboxModel";
import type { DashboardHeaderNavItem } from "../../shell/components/layout/DashboardHeader";

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

/** Name the part of the destinations that a path is in, if any. */
export function paneDestinationForPath(
  pathname: string,
): "automations" | "inbox" | undefined {
  if (pathname === "/" || under(pathname, "/conversations")) return "inbox";
  if (under(pathname, "/automations")) return "automations";
  return undefined;
}

/**
 * Name the row that owns a path. A Conversation belongs to `origin`, the
 * Inbox view that opened it, so that view reopens it; one with no origin,
 * such as a direct link, belongs to Conversations.
 */
export function paneRowForPath(
  location: { pathname: string; search: string },
  navItems: readonly DashboardHeaderNavItem[],
  origin: InboxView | undefined,
): PaneRow | undefined {
  const { pathname } = location;
  if (isOldAutomationsPath(location)) return "automations";
  if (pathname === "/")
    return parseInboxView(new URLSearchParams(location.search).get("view"));
  if (under(pathname, "/conversations")) return origin ?? "conversations";
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
