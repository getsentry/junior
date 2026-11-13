import { Inbox } from "lucide-react";
import { use, type ReactNode } from "react";
import { Link } from "react-router";
import type {
  ReviewItemChangeRecord,
  ReviewItemPayload,
} from "@sentry/junior/api/schema";

import { MessageCard, MessageCardHeader } from "../components/MessageCard";
import {
  TranscriptShowQuestion,
  useAnswerInView,
  useAnswerLinked,
  useAskInView,
} from "../conversations/TranscriptAnswerLinks";
import { useConversationReviewItemData } from "./queries";
import {
  answerLine,
  answerRows,
  assigneeLabel,
  reviewItemPath,
} from "./reviewItemFormat";

// The verb stays muted. The title is the link, so it reads apart from it.
const QUOTE_TITLE_CLASS =
  "min-w-0 cursor-pointer truncate border-0 bg-transparent p-0 text-left font-medium text-dashboard-text underline decoration-dashboard-border-heavy underline-offset-2 hover:decoration-current focus-visible:outline-dashboard-focus";

const CHANGE_VERBS = {
  dismissed: "Dismissed",
  submitted: "Answered",
  taken: "Took",
} as const satisfies Record<ReviewItemChangeRecord["kind"], string>;

// The change reads as the person's reply to a question, and an answer stands
// out in a bubble. A line in the avatar column links an answer to its "Asked"
// record. The quote line names the item only while that record is out of
// view, or when the transcript has no record to link.
function ChangeRow(props: {
  conversationId: string;
  item: ReviewItemPayload;
  record: ReviewItemChangeRecord;
}) {
  const { item, record } = props;
  const showQuestion = use(TranscriptShowQuestion);
  const verb = CHANGE_VERBS[record.kind];
  // An answer is final, so the item's answer is this message's answer.
  const rows =
    record.kind === "submitted" && item.request && item.answer
      ? answerRows(item.request, item.answer)
      : [];
  const linked = useAnswerLinked(item.id) && rows.length > 0;
  const askInView = useAskInView(item.id);
  return (
    <section
      aria-label={`${verb} ${item.title}`}
      className="grid min-w-0 gap-1.5"
    >
      {linked && askInView ? null : (
        <p className="m-0 flex min-w-0 items-center gap-1.5 border-l-2 border-dashboard-border-emphasis pl-2 text-sm text-dashboard-text-muted">
          <span className="shrink-0">{verb}</span>
          {/* A question that this Conversation asked has a row to scroll to.
              One from another Conversation opens on the review desk. */}
          {showQuestion &&
          item.addedByConversationId === props.conversationId ? (
            <button
              className={QUOTE_TITLE_CLASS}
              onClick={() => showQuestion(item)}
              title={item.title}
              type="button"
            >
              {item.title}
            </button>
          ) : (
            <Link
              className={QUOTE_TITLE_CLASS}
              title={item.title}
              to={reviewItemPath(item.id)}
            >
              {item.title}
            </Link>
          )}
        </p>
      )}
      {rows.length ? (
        <dl className="m-0 grid w-fit max-w-full gap-1.5 rounded-xl border border-dashboard-border-emphasis bg-dashboard-surface-panel px-3.5 py-2 font-sans text-base leading-relaxed">
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
  return (
    <ChangeRow
      conversationId={props.conversationId}
      item={data}
      record={props.record}
    />
  );
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

/** Name what Junior did with an item, and how the item closed. */
function askMeta(item: ReviewItemPayload): string {
  const verb = item.kind === "action" ? "Asked" : "Added";
  if (item.status === "open") return verb;
  const by = item.closedBy
    ? ` by ${item.closedBy.displayName ?? item.closedBy.email}`
    : "";
  if (item.status === "dismissed") return `${verb} · Dismissed${by}`;
  return `${verb} · ${item.answer ? "Answered" : "Done"}${by}`;
}

/**
 * Say what an open item waits for, or give the answer. A linked answer row
 * in view already shows the answer.
 */
function askOutcome(
  item: ReviewItemPayload,
  answerShown: boolean,
): string | undefined {
  if (item.status === "open") {
    if (item.kind === "notice") return undefined;
    return item.canAct ? "Waiting on you" : `Waiting on ${assigneeLabel(item)}`;
  }
  if (item.status === "dismissed" || answerShown) return undefined;
  return item.request && item.answer
    ? answerLine(item.request, item.answer)
    : undefined;
}

/**
 * Show the Review item that a tool call added as one line in the transcript:
 * what Junior asked, how it closed, and the answer or what it waits for. A
 * question docks above the message box, so this row is only the record.
 * Shows `fallback` when the viewer cannot read the item.
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
  // The record repeats the answer only while its answer row is out of view.
  const answerShown = useAnswerInView(props.itemId);
  if (isError) return props.fallback;
  if (!item) return null;
  const verb = item.kind === "action" ? "Asked" : "Added";
  const outcome = askOutcome(item, answerShown);
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
        meta={askMeta(item)}
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
