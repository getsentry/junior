import { Inbox } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import type { ReviewItemPayload } from "@sentry/junior/api/schema";

import { StatusChip } from "../components/StatusChip";
import { AnswerSummary } from "./ReviewItemActions";
import { useReviewItemData } from "./queries";
import { reviewItemPath, reviewItemStatusLabel } from "./reviewItemFormat";

function AnswerRow(props: { item: ReviewItemPayload }) {
  const { item } = props;
  return (
    <section
      aria-label={`Answer: ${item.title}`}
      className="grid min-w-0 max-w-[37.5rem] gap-2 rounded-lg border border-dashboard-border bg-dashboard-surface-panel p-3 font-sans text-sm"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Inbox
          aria-hidden="true"
          className="shrink-0 text-dashboard-text-muted"
          size={15}
        />
        <Link
          className="min-w-0 flex-1 truncate font-medium text-dashboard-text no-underline hover:underline focus-visible:outline-dashboard-focus"
          to={reviewItemPath(item.id)}
        >
          {item.title}
        </Link>
        <StatusChip className="shrink-0" size="compact" tone="neutral">
          {reviewItemStatusLabel(item)}
        </StatusChip>
      </div>
      {item.request && item.answer ? (
        <AnswerSummary answer={item.answer} request={item.request} />
      ) : null}
    </section>
  );
}

/**
 * Show a person message that reports a Review item answer as one row for the
 * item. Shows `fallback`, the message text, when the viewer cannot read the
 * item.
 */
export function ReviewItemAnswer(props: {
  fallback: ReactNode;
  itemId: string;
}) {
  const { data, isError } = useReviewItemData(props.itemId);
  if (isError) return props.fallback;
  // The row replaces the text, so wait for the item before showing it.
  if (!data) return null;
  return <AnswerRow item={data} />;
}
