import { ArrowRight, Inbox } from "lucide-react";
import {
  cn,
  dashboardIconTileClass,
  dashboardMessageCardClass,
} from "../../styles";
import { Link } from "react-router";
import type { InboxItemPayload } from "@sentry/junior/api/schema";

import { StatusChip } from "../../components/StatusChip";
import { DisplayText } from "../../display-text/DisplayText";
import { InboxItemActions } from "../../inbox/InboxItemActions";
import { InboxItemObjects } from "../../inbox/InboxItemObjects";
import {
  inboxRowPath,
  itemConversationId,
  inboxItemStatusLabel,
  inboxItemTitleText,
} from "../../inbox/inboxItemFormat";
import {
  InboxItemAssignees,
  InboxItemTitle,
} from "../../inbox/InboxItemPeople";
import { useClosingInboxItem } from "../../inbox/queries";
import { fadeOverflowClass, fadeWhenOverflowing } from "../../textFade";

/**
 * Show one Inbox item as a card: its title, status, description, and the
 * viewer's actions, with a link to its row in the Inbox. The card uses the same
 * frame as transcript object cards, so it reads as one record, not as prose.
 */
export function InboxItemCard(props: { item: InboxItemPayload }) {
  // The status shows as closed as the viewer's action starts.
  const item = useClosingInboxItem(props.item);
  const open = item.status === "open";
  const assigned = item.assignees.length > 0 || item.assignedToEveryone;
  return (
    <section
      aria-label={`Inbox item: ${inboxItemTitleText(item)}`}
      className={cn(
        "my-1 w-full min-w-0 max-w-[37.5rem] overflow-hidden font-sans text-sm text-dashboard-text",
        dashboardMessageCardClass,
      )}
    >
      <header className="flex items-start gap-3 px-4 pb-3 pt-4 md:px-5">
        <span
          aria-hidden="true"
          className={cn(dashboardIconTileClass, "size-9")}
        >
          <Inbox size={18} />
        </span>
        <div className="grid min-w-0 flex-1 gap-1">
          <div className="flex min-w-0 items-center justify-between gap-3">
            <p className="m-0 text-xs text-dashboard-text-muted">Inbox item</p>
            <StatusChip
              className="shrink-0"
              size="compact"
              tone={open ? "accent" : "neutral"}
            >
              {inboxItemStatusLabel(item)}
            </StatusChip>
          </div>
          <h3 className="m-0 break-words text-base font-semibold leading-snug">
            <InboxItemTitle item={item} links />
          </h3>
        </div>
      </header>
      <div className="grid min-w-0 gap-4 px-4 pb-4 md:px-5">
        <InboxItemObjects conversationId={itemConversationId(item)}>
          <DisplayText mentions={item.mentions} text={item.body} />
        </InboxItemObjects>
        <div className="border-t border-dashboard-border pt-4">
          <InboxItemActions item={props.item} />
        </div>
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-dashboard-border bg-dashboard-fill-faint px-4 py-3 text-xs md:px-5">
        <Link
          className="inline-flex items-center gap-2 font-medium text-dashboard-text no-underline hover:underline focus-visible:outline-dashboard-focus"
          // The Inbox shows the item where the server has it.
          to={inboxRowPath(props.item)}
        >
          Open in the Inbox
          <ArrowRight aria-hidden="true" size={14} />
        </Link>
        <span
          className={cn(fadeOverflowClass, "text-dashboard-text-muted")}
          ref={fadeWhenOverflowing}
        >
          {assigned ? (
            <>
              Assigned to <InboxItemAssignees item={item} />
            </>
          ) : (
            "Unassigned"
          )}
        </span>
      </footer>
    </section>
  );
}
