import { ArrowRight, Inbox } from "lucide-react";
import { Link } from "react-router";
import type { ReviewItemPayload } from "@sentry/junior/api/schema";

import { StatusChip } from "../components/StatusChip";
import { TranscriptMarkdown } from "../conversations/TranscriptMarkdown";
import { cn } from "../styles";
import { ReviewItemActions } from "./ReviewItemActions";
import { useReviewItemData } from "./queries";
import {
  assigneeLabel,
  reviewItemPath,
  reviewItemStatusLabel,
} from "./reviewItemFormat";

/**
 * Show one Review item as a card: its title, status, description, and the
 * viewer's actions, with a link to the review desk. The card uses the same
 * frame as transcript object cards, so it reads as one record, not as prose.
 */
export function ReviewItemCard(props: { item: ReviewItemPayload }) {
  const { item } = props;
  const open = item.status === "open";
  const assigned = item.assignees.length > 0 || item.assignedToEveryone;
  return (
    <section
      aria-label={`Review item: ${item.title}`}
      className="my-1 w-full min-w-0 max-w-[37.5rem] overflow-hidden rounded-xl border border-dashboard-border-emphasis bg-dashboard-surface-panel font-sans text-sm text-dashboard-text"
    >
      <header className="flex items-start gap-3 px-4 pb-3 pt-4 md:px-5">
        {/* The accent tile marks an item that still needs a person. */}
        <span
          aria-hidden="true"
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-lg border",
            open
              ? "border-dashboard-accent/30 bg-dashboard-accent/10 text-dashboard-accent"
              : "border-dashboard-border bg-dashboard-fill-soft text-dashboard-text-muted",
          )}
        >
          <Inbox size={18} />
        </span>
        <div className="grid min-w-0 flex-1 gap-1">
          <div className="flex min-w-0 items-center justify-between gap-3">
            <p className="m-0 text-xs text-dashboard-text-muted">Review item</p>
            <StatusChip
              className="shrink-0"
              size="compact"
              tone={open ? "accent" : "neutral"}
            >
              {reviewItemStatusLabel(item)}
            </StatusChip>
          </div>
          <h3 className="m-0 break-words text-base font-semibold leading-snug">
            {item.title}
          </h3>
        </div>
      </header>
      <div className="grid min-w-0 gap-4 px-4 pb-4 md:px-5">
        <TranscriptMarkdown text={item.body} />
        <div className="border-t border-dashboard-border pt-4">
          <ReviewItemActions item={item} />
        </div>
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-dashboard-border bg-dashboard-fill-faint px-4 py-3 text-xs md:px-5">
        <Link
          className="inline-flex items-center gap-2 font-medium text-dashboard-text no-underline hover:underline focus-visible:outline-dashboard-focus"
          to={reviewItemPath(item.id)}
        >
          Open on the review desk
          <ArrowRight aria-hidden="true" size={14} />
        </Link>
        <span className="min-w-0 truncate text-dashboard-text-muted">
          {assigned ? `Assigned to ${assigneeLabel(item)}` : "Unassigned"}
        </span>
      </footer>
    </section>
  );
}

/**
 * Show the card of the Review item that a tool call added. It shows nothing
 * when the viewer cannot see the item.
 */
export function TranscriptReviewItemCard(props: { itemId: string }) {
  const item = useReviewItemData(props.itemId).data;
  return item ? <ReviewItemCard item={item} /> : null;
}
