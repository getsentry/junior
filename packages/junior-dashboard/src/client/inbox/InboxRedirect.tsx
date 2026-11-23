import { Navigate, useSearchParams } from "react-router";

import { oldPullRequestsTarget } from "../components/layout/paneRows";
import { inboxViewPath } from "./inboxModel";
import { useInboxItemData } from "./queries";

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
  if (bundle === "prs")
    return <Navigate replace to={oldPullRequestsTarget(params.toString())} />;
  if (!bundle && itemId && item.isPending) return null;
  const view =
    bundle === "decisions" || bundle === "done"
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
