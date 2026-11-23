import { ArrowRight, Inbox } from "lucide-react";
import { Link } from "react-router";
import type { InboxItemPayload } from "@sentry/junior/api/schema";

import { StatusChip } from "../components/StatusChip";
import { DisplayText, RichLinksProvider } from "../display-text/DisplayText";
import {
  cn,
  dashboardIconTileClass,
  dashboardMessageCardClass,
} from "../styles";
import { InboxItemActions } from "./InboxItemActions";
import { InboxItemObjects } from "./InboxItemObjects";
import {
  itemConversationId,
  inboxItemPath,
  inboxItemStatusLabel,
  inboxItemTitleText,
} from "./inboxItemFormat";
import { InboxItemAssignees, InboxItemTitle } from "./InboxItemPeople";

/**
 * Show one Inbox item as a card: its title, status, description, and the
 * viewer's actions, with a link to the Inbox. The card uses the same
 * frame as transcript object cards, so it reads as one record, not as prose.
 * Its links stay rich when the browser chose plain links.
 */
export function InboxItemCard(props: { item: InboxItemPayload }) {
  const { item } = props;
  const open = item.status === "open";
  const assigned = item.assignees.length > 0 || item.assignedToEveryone;
  return (
    <RichLinksProvider value>
      <section
        aria-label={`Inbox item: ${inboxItemTitleText(item)}`}
        className={cn(
          "my-1 w-full min-w-0 max-w-[37.5rem] overflow-hidden font-sans text-sm text-dashboard-text",
          dashboardMessageCardClass,
        )}
      >
        <header className="flex items-start gap-3 px-4 pb-3 pt-4 md:px-5">
          {/* The accent tile marks an item that still needs a person. */}
          <span
            aria-hidden="true"
            className={cn(
              "size-9",
              open
                ? "grid shrink-0 place-items-center rounded-md border border-dashboard-accent/30 bg-dashboard-accent/10 text-dashboard-accent"
                : dashboardIconTileClass,
            )}
          >
            <Inbox size={18} />
          </span>
          <div className="grid min-w-0 flex-1 gap-1">
            <div className="flex min-w-0 items-center justify-between gap-3">
              <p className="m-0 text-xs text-dashboard-text-muted">
                Inbox item
              </p>
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
            <InboxItemActions item={item} />
          </div>
        </div>
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-dashboard-border bg-dashboard-fill-faint px-4 py-3 text-xs md:px-5">
          <Link
            className="inline-flex items-center gap-2 font-medium text-dashboard-text no-underline hover:underline focus-visible:outline-dashboard-focus"
            to={inboxItemPath(item.id)}
          >
            Open in the Inbox
            <ArrowRight aria-hidden="true" size={14} />
          </Link>
          <span className="min-w-0 truncate text-dashboard-text-muted">
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
    </RichLinksProvider>
  );
}
