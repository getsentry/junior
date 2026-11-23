import { Navigate, useSearchParams } from "react-router";

import { inboxViewPath } from "./inboxModel";
import { useInboxItemData } from "./queries";

/**
 * True for an old Inbox link, which names an entry by `?bundle=` or an item
 * with no `?view=`. A list link always has `?view=` with its item.
 */
export function isOldInboxLink(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.has("bundle") || (params.has("item") && !params.has("view"));
}

/**
 * Old Inbox links and the classic UI's `/inbox` and `/review` links open the list:
 * `?bundle=` picks the matching entry, and `?item=` expands that item's
 * row, on Done when the item has closed. `?snooze=` stays, for
 * `LinkedSnoozeDialog`.
 */
export function InboxRedirect() {
  const [params] = useSearchParams();
  const bundle = params.get("bundle");
  const itemId = params.get("item") ?? undefined;
  // Only a link with no entry needs the item's status.
  const item = useInboxItemData(bundle ? undefined : itemId);
  if (bundle === "automations") return <Navigate replace to="/automations" />;
  if (!bundle && itemId && item.isPending) return null;
  const view =
    bundle === "prs" || bundle === "decisions" || bundle === "done"
      ? bundle
      : item.data && item.data.status !== "open"
        ? "done"
        : "inbox";
  const path = inboxViewPath(view, { itemId });
  // An item link always has a query, so the flag joins it.
  return (
    <Navigate
      replace
      to={itemId && params.get("snooze") ? `${path}&snooze=1` : path}
    />
  );
}
