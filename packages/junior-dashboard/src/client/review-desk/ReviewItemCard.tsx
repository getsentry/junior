import { Link } from "react-router";
import type { ReviewItemPayload } from "@sentry/junior/api/schema";

import { StatusChip } from "../components/StatusChip";
import { ReviewItemActions } from "./ReviewItemActions";
import { useReviewItemData } from "./queries";
import { reviewItemPath } from "./reviewItemFormat";

function statusLabel(item: ReviewItemPayload): string {
  if (item.status === "open") {
    return item.kind === "action" ? "Needs an answer" : "Notice";
  }
  return item.status === "done" ? "Done" : "Dismissed";
}

/**
 * Show one Review item as a card: its title, status, and the viewer's
 * actions, with a link to the review desk.
 */
export function ReviewItemCard(props: { item: ReviewItemPayload }) {
  const { item } = props;
  return (
    <section
      aria-label={`Review item: ${item.title}`}
      className="grid gap-2 rounded-lg border border-violet-300/25 bg-violet-300/[0.06] px-3 py-2.5 font-sans text-sm text-dashboard-text"
    >
      <header className="flex min-w-0 items-baseline justify-between gap-3">
        <span className="min-w-0 truncate font-medium">{item.title}</span>
        <StatusChip
          className="shrink-0"
          size="compact"
          tone={item.status === "open" ? "accent" : "neutral"}
        >
          {statusLabel(item)}
        </StatusChip>
      </header>
      <ReviewItemActions item={item} />
      <Link className="w-fit text-xs" to={reviewItemPath(item.id)}>
        Open on the review desk
      </Link>
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
