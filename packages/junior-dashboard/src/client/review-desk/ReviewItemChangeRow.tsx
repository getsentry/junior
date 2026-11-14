import {
  ArrowDown,
  CircleCheck,
  CircleSlash,
  Clock3,
  Inbox,
  Info,
  type LucideIcon,
} from "lucide-react";
import { use, type ReactElement, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import type {
  ReviewItemChangeRecord,
  ReviewItemPayload,
} from "@sentry/junior/api/schema";

import { HoverPreview } from "../components/ui/hover-preview";
import { FOCUS_REPLY_STATE } from "../conversations/conversationRoutes";
import { cn } from "../styles";
import {
  TranscriptShowQuestion,
  useAnswerInView,
  useAnswerLinked,
} from "../conversations/TranscriptAnswerLinks";
import { DisplayText } from "../display-text/DisplayText";
import { useConversationReviewItemData } from "./queries";
import { AnswerSummary } from "./ReviewItemActions";
import { ReviewItemObjects } from "./ReviewItemObjects";
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

/**
 * Show what an item asked, and its answer, when the reader hovers or focuses
 * its title. A transcript record names the item only by its title.
 */
function ReviewItemPreview(props: {
  children: ReactNode;
  item: ReviewItemPayload;
  trigger: ReactElement;
}) {
  const { answer, request } = props.item;
  return (
    <HoverPreview
      className="grid gap-3 p-4 font-sans text-sm text-dashboard-text"
      content={
        <>
          {/* A quote line can truncate the title, so the card repeats it. */}
          <p className="m-0 break-words text-base font-semibold leading-snug">
            {props.item.title}
          </p>
          {/* A notice or a plugin item has no question: its text is the ask. */}
          <ReviewItemObjects conversationId={props.item.addedByConversationId}>
            <DisplayText text={request?.question ?? props.item.body} />
          </ReviewItemObjects>
          {request && answer ? (
            <AnswerSummary answer={answer} request={request} />
          ) : null}
        </>
      }
      trigger={props.trigger}
    >
      {props.children}
    </HoverPreview>
  );
}

// The change reads as the person's reply to a question, and an answer stands
// out in a bubble. A line in the avatar column links an answer to its "Asked"
// record. The quote line always shows: hiding it while the record is in view
// changed the row height, and the rows below it moved.
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
  const askLinked = useAnswerLinked(item.id);
  // The page can show a question that has a row here, or load the history
  // around the Turn that asked it. A plugin item has neither, so it opens on
  // the review desk, as does an item from another Conversation.
  const scrollsToQuestion =
    showQuestion !== undefined &&
    item.addedByConversationId === props.conversationId &&
    (askLinked || item.addedByTurnId !== undefined);
  return (
    <section
      aria-label={`${verb} ${item.title}`}
      className="grid min-w-0 gap-1.5"
    >
      <p className="m-0 flex min-w-0 items-center gap-1.5 border-l-2 border-dashboard-border-emphasis pl-2 text-sm text-dashboard-text-muted">
        <span className="shrink-0">{verb}</span>
        <ReviewItemPreview
          item={item}
          trigger={
            showQuestion && scrollsToQuestion ? (
              <button
                className={QUOTE_TITLE_CLASS}
                onClick={() => showQuestion(item)}
                type="button"
              />
            ) : (
              <Link
                className={QUOTE_TITLE_CLASS}
                to={reviewItemPath(item.id)}
              />
            )
          }
        >
          {item.title}
        </ReviewItemPreview>
      </p>
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

type AskStatus = {
  icon: LucideIcon;
  iconClassName: string;
  label: string;
  /** The answer, while the reader cannot see its answer row. */
  answer?: string;
  waitingOnYou?: boolean;
};

/** Say where an item stands: who it waits on, or how it closed and by whom. */
function askStatus(item: ReviewItemPayload, answerShown: boolean): AskStatus {
  if (item.status === "open") {
    if (item.kind === "notice") {
      return {
        icon: Info,
        iconClassName: "text-dashboard-text-muted",
        label: `Added for ${assigneeLabel(item)}`,
      };
    }
    return item.canAct
      ? {
          icon: Inbox,
          iconClassName: "text-dashboard-accent-text",
          label: "Waiting on you",
          waitingOnYou: true,
        }
      : {
          icon: Clock3,
          iconClassName: "text-amber-400",
          label: `Waiting on ${assigneeLabel(item)}`,
        };
  }
  const by = item.closedBy
    ? ` by ${item.closedBy.displayName ?? item.closedBy.email}`
    : "";
  if (item.status === "dismissed") {
    return {
      icon: CircleSlash,
      iconClassName: "text-dashboard-text-faint",
      label: `Dismissed${by}`,
    };
  }
  return {
    answer:
      !answerShown && item.request && item.answer
        ? answerLine(item.request, item.answer)
        : undefined,
    icon: CircleCheck,
    iconClassName: "text-emerald-500",
    label: `${item.answer ? "Answered" : "Done"}${by}`,
  };
}

// The question docks above the message box, so the reader answers there. A
// reply focus request shows this question in the dock and moves focus to it.
// That request skips a touch screen, where the docked question is already
// in sight, so the button is not shown there.
function AnswerButton(props: { itemId: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <button
      className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md bg-violet-500/15 pointer-coarse:hidden px-2.5 py-1 text-xs font-medium text-dashboard-accent-text transition-colors hover:bg-violet-500/25 focus-visible:outline-2 focus-visible:outline-dashboard-focus"
      onClick={() =>
        navigate(
          { pathname: location.pathname, search: location.search },
          {
            replace: true,
            state: { ...FOCUS_REPLY_STATE, questionId: props.itemId },
          },
        )
      }
      type="button"
    >
      Answer
      <ArrowDown aria-hidden="true" className="size-3.5" />
    </button>
  );
}

/**
 * Show the Review item that a tool call added as a compact card in the
 * transcript: the title, where it stands, and the answer. An item that waits
 * on the reader stands out and offers to answer its docked question. Shows
 * `fallback` when the viewer cannot read the item.
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
  const status = askStatus(item, answerShown);
  const Icon = status.icon;
  // Only a question from this Conversation docks above its message box.
  const docked =
    status.waitingOnYou && item.addedByConversationId === props.conversationId;
  return (
    // The transcript marks the row for a moment when its question docks.
    <section
      aria-label={`${verb} ${item.title}`}
      className={cn(
        "flex w-full min-w-0 max-w-[37.5rem] items-center gap-3 rounded-lg border px-3 py-2.5 font-sans text-sm transition-shadow duration-300 motion-reduce:transition-none data-highlighted:ring-2 data-highlighted:ring-violet-300/50",
        status.waitingOnYou
          ? "border-violet-400/40 bg-violet-500/[0.07]"
          : "border-dashboard-border-subtle bg-dashboard-surface-panel",
      )}
      data-review-item-ask={item.id}
    >
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md",
          status.waitingOnYou ? "bg-violet-500/15" : "bg-dashboard-fill-faint",
        )}
      >
        <Icon
          aria-hidden="true"
          className={cn("size-4", status.iconClassName)}
        />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <ReviewItemPreview
          item={item}
          trigger={
            <Link
              className={cn(
                "min-w-0 truncate font-medium no-underline hover:underline focus-visible:outline-dashboard-focus",
                item.status === "dismissed"
                  ? "text-dashboard-text-muted"
                  : "text-dashboard-text",
              )}
              to={reviewItemPath(item.id)}
            />
          }
        >
          {item.title}
        </ReviewItemPreview>
        <p className="m-0 flex min-w-0 gap-1 text-xs">
          <span
            className={
              status.waitingOnYou
                ? "shrink-0 font-medium text-dashboard-accent-text"
                : "shrink-0 text-dashboard-text-muted"
            }
          >
            {status.label}
          </span>
          {status.answer ? (
            <>
              <span aria-hidden="true" className="text-dashboard-text-faint">
                ·
              </span>
              <span
                className="min-w-0 truncate text-dashboard-text-subtle"
                title={status.answer}
              >
                {status.answer}
              </span>
            </>
          ) : null}
        </p>
      </div>
      {docked ? <AnswerButton itemId={item.id} /> : null}
    </section>
  );
}
