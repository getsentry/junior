import { Inbox } from "lucide-react";
import { use, type ReactNode } from "react";
import { Link } from "react-router";
import type {
  ReviewItemChangeRecord,
  ReviewItemPayload,
} from "@sentry/junior/api/schema";

import { MessageCard, MessageCardHeader } from "../components/MessageCard";
import { TranscriptBackToBackAnswers } from "../conversations/transcriptBackToBackAnswers";
import { useConversationReviewItemData } from "./queries";
import {
  answerLine,
  answerRows,
  assigneeLabel,
  reviewItemPath,
} from "./reviewItemFormat";

const CHANGE_VERBS = {
  dismissed: "Dismissed",
  submitted: "Answered",
  taken: "Took",
} as const satisfies Record<ReviewItemChangeRecord["kind"], string>;

// The change reads as the person's reply to a question: a quote line names
// the item, and an answer is the message text. Only the "Asked" record is a
// card, so the question and its answer do not repeat the same card. Right
// under its question, an answer needs no quote line.
function ChangeRow(props: {
  item: ReviewItemPayload;
  record: ReviewItemChangeRecord;
}) {
  const { item, record } = props;
  const verb = CHANGE_VERBS[record.kind];
  // An answer is final, so the item's answer is this message's answer.
  const rows =
    record.kind === "submitted" && item.request && item.answer
      ? answerRows(item.request, item.answer)
      : [];
  const backToBack =
    use(TranscriptBackToBackAnswers).has(item.id) &&
    record.kind === "submitted" &&
    rows.length > 0;
  return (
    <section
      aria-label={`${verb} ${item.title}`}
      className="grid min-w-0 gap-1.5"
    >
      {backToBack ? null : (
        <p className="m-0 flex min-w-0 items-center gap-1.5 border-l-2 border-dashboard-border-emphasis pl-2 text-sm text-dashboard-text-muted">
          <span className="shrink-0">{verb}</span>
          <Link
            className="min-w-0 truncate text-dashboard-text-muted no-underline hover:text-dashboard-text hover:underline focus-visible:outline-dashboard-focus"
            title={item.title}
            to={reviewItemPath(item.id)}
          >
            {item.title}
          </Link>
        </p>
      )}
      {rows.length ? (
        <dl className="m-0 grid gap-1.5 font-sans text-base leading-relaxed">
          {rows.map((row) => (
            <div key={row.label}>
              {/* One answer needs no label: a quote or the question names it. */}
              <dt
                className={
                  rows.length > 1
                    ? "text-xs font-medium text-dashboard-text-muted"
                    : "sr-only"
                }
              >
                {row.label}
              </dt>
              <dd className="m-0 whitespace-pre-wrap break-words">
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}

function ReviewItemTitle(props: { item: ReviewItemPayload }) {
  return (
    <Link
      className="break-words text-base font-semibold text-dashboard-text no-underline hover:underline focus-visible:outline-dashboard-focus"
      to={reviewItemPath(props.item.id)}
    >
      {props.item.title}
    </Link>
  );
}

/**
 * Show the Review item change that a message records as one row: what the
 * message did and the item it did it to. The row shows the change from the
 * message, not the item's current state, so a take stays a take after a
 * later answer. Shows `fallback` when the viewer cannot read the item.
 */
export function ReviewItemChangeRow(props: {
  conversationId: string;
  fallback: ReactNode;
  record: ReviewItemChangeRecord;
}) {
  const { data, isError } = useConversationReviewItemData(
    props.conversationId,
    props.record.reviewItemId,
  );
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
  conversationId: string;
  fallback: ReactNode;
  record: ReviewItemChangeRecord;
}) {
  const { data } = useConversationReviewItemData(
    props.conversationId,
    props.record.reviewItemId,
  );
  if (!data) return props.fallback;
  return (
    <>
      {CHANGE_VERBS[props.record.kind]}{" "}
      <span className="font-medium text-dashboard-text">{data.title}</span>
    </>
  );
}

/** Say what an asked item waits for, or what closed it. */
function askOutcome(item: ReviewItemPayload): string | undefined {
  if (item.status === "open") {
    if (item.kind === "notice") return undefined;
    return item.canAct ? "Waiting on you" : `Waiting on ${assigneeLabel(item)}`;
  }
  if (item.status === "dismissed") return "Dismissed";
  return item.request && item.answer
    ? answerLine(item.request, item.answer)
    : "Done";
}

/**
 * Show the Review item that a tool call added as one line in the transcript:
 * what Junior asked, and the answer or what it waits for. A question docks
 * above the message box, so this row is only the record. Shows `fallback`
 * when the viewer cannot read the item.
 */
export function ReviewItemAskRow(props: {
  conversationId: string;
  fallback: ReactNode;
  itemId: string;
}) {
  const { data: item, isError } = useConversationReviewItemData(
    props.conversationId,
    props.itemId,
  );
  const backToBack = use(TranscriptBackToBackAnswers).has(props.itemId);
  if (isError) return props.fallback;
  if (!item) return null;
  const verb = item.kind === "action" ? "Asked" : "Added";
  // The answer row right below shows the answer.
  const outcome =
    backToBack && item.status === "done" ? undefined : askOutcome(item);
  return (
    // The transcript marks the row for a moment when its question docks.
    <MessageCard
      aria-label={`${verb} ${item.title}`}
      className="transition-shadow duration-300 motion-reduce:transition-none data-highlighted:ring-2 data-highlighted:ring-violet-300/50"
      data-review-item-ask={item.id}
    >
      <MessageCardHeader
        className={outcome ? undefined : "pb-4"}
        icon={<Inbox aria-hidden="true" size={18} />}
        meta={verb}
        title={<ReviewItemTitle item={item} />}
      />
      {outcome ? (
        <p
          className={
            item.status === "open"
              ? "m-0 break-words px-4 pb-4 text-dashboard-accent-text md:px-5"
              : "m-0 break-words px-4 pb-4 text-dashboard-text-muted md:px-5"
          }
        >
          {outcome}
        </p>
      ) : null}
    </MessageCard>
  );
}
