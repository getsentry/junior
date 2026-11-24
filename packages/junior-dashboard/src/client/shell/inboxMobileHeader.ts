import { returnPathLabel, isCodePath } from "../components/layout/paneRows";
import {
  COMPOSER_PATH,
  isNewConversationPath,
} from "../conversations/conversationRoutes";
import { INBOX_VIEW_LABELS, parseInboxView } from "../inbox/inboxModel";
import { NAV_PAGES } from "../navPages";
import { CODE_ALL_PATH } from "../pages/code/codeRepositoryRoutes";

/**
 * Where the phone header's Back goes on an Inbox page, and its title: a
 * Conversation and the composer go back to the list, a list and Code go
 * back to the entries, and a repository goes back to Code · All.
 */
export function inboxMobileHeader(
  pathname: string,
  search: string,
  returnPath: string,
): { backLabel?: string; backTo?: string; title?: string } {
  const back = (to: string) => ({
    backLabel: `Back to ${returnPathLabel(to)}`,
    backTo: to,
  });
  if (pathname === COMPOSER_PATH)
    return { ...back(returnPath), title: "New conversation" };
  if (conversationIdFromPath(pathname)) return back(returnPath);
  if (pathname === NAV_PAGES.code.to)
    return {
      backLabel: "Back to the Inbox entries",
      backTo: NAV_PAGES.inbox.to,
      title: "Code",
    };
  if (isCodePath(pathname)) return { ...back(CODE_ALL_PATH), title: "Code" };
  const view = new URLSearchParams(search).get("view");
  // A list's Back goes to the entries, which `/inbox` shows on a phone.
  if (pathname === NAV_PAGES.inbox.to && view !== null)
    return {
      backLabel: "Back to the Inbox entries",
      backTo: NAV_PAGES.inbox.to,
      title: INBOX_VIEW_LABELS[parseInboxView(view)],
    };
  return {};
}

/** Read the selected conversation id from a workspace detail path. */
export function conversationIdFromPath(pathname: string): string | undefined {
  if (isNewConversationPath(pathname)) return undefined;
  const match = pathname.match(/^\/conversations\/([^/]+)$/);
  if (!match?.[1]) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}
