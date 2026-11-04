import { Inbox } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import type {
  ReviewItemChangeRecord,
  ReviewItemPayload,
} from "@sentry/junior/api/schema";

import { AnswerSummary } from "./ReviewItemActions";
import { useReviewItemData } from "./queries";
import { reviewItemPath } from "./reviewItemFormat";

const CHANGE_VERBS = {
  dismissed: "Dismissed",
  submitted: "Answered",
  taken: "Took",
} as const satisfies Record<ReviewItemChangeRecord["kind"], string>;

function ChangeRow(props: {
  item: ReviewItemPayload;
  record: ReviewItemChangeRecord;
}) {
  const { item, record } = props;
  const verb = CHANGE_VERBS[record.kind];
  return (
    <section
      aria-label={`${verb} ${item.title}`}
      className="grid min-w-0 max-w-[37.5rem] gap-2 rounded-lg border border-dashboard-border bg-dashboard-surface-panel p-3 font-sans text-sm"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Inbox
          aria-hidden="true"
          className="shrink-0 text-dashboard-text-muted"
          size={15}
        />
        <span className="shrink-0 text-dashboard-text-muted">{verb}</span>
        <Link
          className="min-w-0 flex-1 truncate font-medium text-dashboard-text no-underline hover:underline focus-visible:outline-dashboard-focus"
          to={reviewItemPath(item.id)}
        >
          {item.title}
        </Link>
      </div>
      {/* An answer is final, so the item's answer is this message's answer. */}
      {record.kind === "submitted" && item.request && item.answer ? (
        <AnswerSummary answer={item.answer} request={item.request} />
      ) : null}
    </section>
  );
}

/**
 * Show the Review item change that a message records as one row: what the
 * message did and the item it did it to. The row shows the change from the
 * message, not the item's current state, so a take stays a take after a
 * later answer. Shows `fallback` when the viewer cannot read the item.
 */
export function ReviewItemChangeRow(props: {
  fallback: ReactNode;
  record: ReviewItemChangeRecord;
}) {
  const { data, isError } = useReviewItemData(props.record.reviewItemId);
  if (isError) return props.fallback;
  // The row replaces the text, so wait for the item before showing it.
  if (!data) return null;
  return <ChangeRow item={data} record={props.record} />;
}

/**
 * Name the Review item change that a queued message records, on one line.
 * Shows `fallback` until the item loads or when the viewer cannot read it.
 */
export function ReviewItemChangeLabel(props: {
  fallback: ReactNode;
  record: ReviewItemChangeRecord;
}) {
  const { data } = useReviewItemData(props.record.reviewItemId);
  if (!data) return props.fallback;
  return (
    <>
      {CHANGE_VERBS[props.record.kind]}{" "}
      <span className="font-medium text-dashboard-text">{data.title}</span>
    </>
  );
}
