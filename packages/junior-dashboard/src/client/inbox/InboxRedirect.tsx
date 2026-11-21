import { Navigate, useSearchParams } from "react-router";

import { inboxViewPath } from "./inboxModel";
import { useInboxItemData } from "./queries";

/**
 * Old Inbox links and the classic UI's `/inbox` and `/review` links open the list:
 * `?bundle=` picks the matching entry, and `?item=` expands that item's
 * row, on Done when the item has closed.
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
  return <Navigate replace to={inboxViewPath(view, { itemId })} />;
}
