import { Inbox } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import type {
  ReviewItemChangeRecord,
  ReviewItemPayload,
} from "@sentry/junior/api/schema";

import { MessageCard, MessageCardHeader } from "../components/MessageCard";
import { AnswerSummary } from "./ReviewItemActions";
import { useConversationReviewItemData } from "./queries";
import { answerLine, assigneeLabel, reviewItemPath } from "./reviewItemFormat";

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
  // An answer is final, so the item's answer is this message's answer.
  const answer = record.kind === "submitted" ? item.answer : undefined;
  return (
    <MessageCard aria-label={`${verb} ${item.title}`}>
      <MessageCardHeader
        className={answer && item.request ? undefined : "pb-4"}
        icon={<Inbox aria-hidden="true" size={18} />}
        meta={verb}
        title={<ReviewItemTitle item={item} />}
      />
      {answer && item.request ? (
        <div className="px-4 pb-4 md:px-5">
          <AnswerSummary answer={answer} request={item.request} />
        </div>
      ) : null}
    </MessageCard>
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
  if (isError) return props.fallback;
  if (!item) return null;
  const verb = item.kind === "action" ? "Asked" : "Added";
  const outcome = askOutcome(item);
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
