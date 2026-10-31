import { Link } from "react-router";
import type { ReviewItemPayload } from "@sentry/junior/api/schema";

import { StatusChip } from "../components/StatusChip";
import { TranscriptMarkdown } from "../conversations/TranscriptMarkdown";
import { ReviewItemActions } from "./ReviewItemActions";
import { useReviewItemData } from "./queries";
import { reviewItemPath, reviewItemStatusLabel } from "./reviewItemFormat";

/**
 * Show one Review item as a card: its title, status, description, and the
 * viewer's actions, with a link to the review desk.
 */
export function ReviewItemCard(props: { item: ReviewItemPayload }) {
  const { item } = props;
  return (
    <section
      aria-label={`Review item: ${item.title}`}
      className="grid gap-3 rounded-lg border border-violet-300/25 bg-violet-300/[0.06] p-3 font-sans text-sm text-dashboard-text"
    >
      <header className="flex min-w-0 items-baseline justify-between gap-3">
        <span className="min-w-0 truncate font-medium">{item.title}</span>
        <StatusChip
          className="shrink-0"
          size="compact"
          tone={item.status === "open" ? "accent" : "neutral"}
        >
          {reviewItemStatusLabel(item)}
        </StatusChip>
      </header>
      <TranscriptMarkdown text={item.body} />
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
