import { CircleCheck, Inbox, Info, type LucideIcon } from "lucide-react";
import { use, useState, type ReactElement, type ReactNode } from "react";
import { Link } from "react-router";
import {
  inboxItemQuestion,
  type ConversationQuestion,
  type InboxItemChangeRecord,
} from "@sentry/junior/api/schema";

import { HoverPreview } from "../components/ui/hover-preview";
import { cn, dashboardMessageCardClass } from "../styles";
import {
  useAskedQuestionId,
  useConversationQuestion,
  waitingQuestionItem,
} from "../conversations/conversationQuestions";
import {
  TranscriptShowQuestion,
  useAnswerInView,
  useAnswerLinked,
} from "../conversations/TranscriptAnswerLinks";
import { DisplayText } from "../display-text/DisplayText";
import { useMobileLayout } from "../layoutMedia";
import { useViewerWaits } from "./queries";
import { AnswerSummary, InboxItemActions } from "./InboxItemActions";
import { InboxItemObjects } from "./InboxItemObjects";
import { InboxItemSheet } from "./InboxItemSheet";
import { InboxItemTitle } from "./InboxItemPeople";
import { InboxItemTurnMessage } from "./InboxItemTurnMessage";
import { useQuestionInViewRef } from "./WaitingQuestions";
import {
  answerLine,
  answerRows,
  inboxItemPath,
  inboxItemTitleText,
  type InboxItemAsk,
} from "./inboxItemFormat";

// The verb stays muted. The title is the link, so it reads apart from it.
const QUOTE_TITLE_CLASS =
  "min-w-0 cursor-pointer truncate border-0 bg-transparent p-0 text-left font-medium text-dashboard-text underline decoration-dashboard-border-heavy underline-offset-2 hover:decoration-current focus-visible:outline-dashboard-focus";

const CHANGE_VERBS = {
  dismissed: "Dismissed",
  submitted: "Answered",
  taken: "Took",
} as const satisfies Record<InboxItemChangeRecord["kind"], string>;

/**
 * Show what a question asked, and its answer, when the reader hovers or
 * focuses its title. A transcript record names the question only by its
 * title.
 */
function QuestionPreview(props: {
  children: ReactNode;
  conversationId: string;
  question: ConversationQuestion;
  trigger: ReactElement;
}) {
  const { answer } = props.question;
  const request = inboxItemQuestion(props.question.request);
  return (
    <HoverPreview
      className="grid gap-3 p-4 font-sans text-sm text-dashboard-text"
      content={
        <>
          {/* A quote line can truncate the title, so the card repeats it. */}
          <p className="m-0 break-words text-base font-semibold leading-snug">
            <InboxItemTitle item={props.question} links />
          </p>
          {/* A notice has no question: its text is the ask. */}
          <InboxItemObjects conversationId={props.conversationId}>
            <DisplayText
              mentions={props.question.mentions}
              text={request?.question ?? props.question.body}
            />
          </InboxItemObjects>
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
  question: ConversationQuestion;
  record: InboxItemChangeRecord;
}) {
  const { question, record } = props;
  const itemId = record.reviewItemId;
  const showQuestion = use(TranscriptShowQuestion);
  const verb = CHANGE_VERBS[record.kind];
  // An answer is final, so the question's answer is this message's answer.
  const form = inboxItemQuestion(question.request);
  const rows =
    record.kind === "submitted" && form && question.answer
      ? answerRows(form, question.answer)
      : [];
  const askLinked = useAnswerLinked(itemId);
  // The page can show a question that has a row here, or load the history
  // around the Turn that asked it. Otherwise it opens on the Inbox.
  const scrollsToQuestion =
    showQuestion !== undefined && (askLinked || question.turnId !== undefined);
  return (
    <section
      aria-label={`${verb} ${inboxItemTitleText(question)}`}
      className="grid min-w-0 gap-1.5"
    >
      <p className="m-0 flex min-w-0 items-center gap-1.5 border-l-2 border-dashboard-border-emphasis pl-2 text-sm text-dashboard-text-muted">
        <span className="shrink-0">{verb}</span>
        <QuestionPreview
          conversationId={props.conversationId}
          question={question}
          trigger={
            showQuestion && scrollsToQuestion ? (
              <button
                className={QUOTE_TITLE_CLASS}
                onClick={() =>
                  showQuestion({ itemId, turnId: question.turnId })
                }
                type="button"
              />
            ) : (
              <Link className={QUOTE_TITLE_CLASS} to={inboxItemPath(itemId)} />
            )
          }
        >
          <InboxItemTitle item={question} />
        </QuestionPreview>
      </p>
      {rows.length ? (
        <dl
          className={cn(
            "m-0 grid w-fit max-w-full gap-1.5 px-3.5 py-2 font-sans text-base leading-relaxed",
            dashboardMessageCardClass,
          )}
        >
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
 * Read the question of the item that a change record names, from the ask
 * in the loaded transcript. `unavailable` is true when no loaded tool call
 * added the item, or the viewer cannot read the question.
 */
function useRecordQuestion(
  conversationId: string,
  record: InboxItemChangeRecord,
) {
  return useConversationQuestion(
    conversationId,
    useAskedQuestionId(conversationId, record.reviewItemId),
  );
}

/**
 * Show the Inbox item change that a message records as one row: what the
 * message did and the question it did it to. The row shows the change from
 * the message, not the question's current state, so a take stays a take
 * after a later answer. Shows `fallback` when the question is not loaded
 * or the viewer cannot read it.
 */
export function InboxItemChangeRow(props: {
  conversationId: string;
  fallback: ReactNode;
  record: InboxItemChangeRecord;
}) {
  const { question, unavailable } = useRecordQuestion(
    props.conversationId,
    props.record,
  );
  if (unavailable) return props.fallback;
  // The row replaces the text, so wait for the question before showing it.
  if (!question) return null;
  return (
    <ChangeRow
      conversationId={props.conversationId}
      question={question}
      record={props.record}
    />
  );
}

/**
 * Name the Inbox item change that a queued message records, on one line.
 * Shows `fallback` until the question loads or when it is not available.
 */
export function InboxItemChangeLabel(props: {
  conversationId: string;
  fallback: ReactNode;
  record: InboxItemChangeRecord;
}) {
  const { question } = useRecordQuestion(props.conversationId, props.record);
  if (!question) return props.fallback;
  return (
    <>
      {CHANGE_VERBS[props.record.kind]}{" "}
      <span className="font-medium text-dashboard-text">
        <InboxItemTitle item={question} />
      </span>
    </>
  );
}

type AskStatus = {
  icon: LucideIcon;
  iconClassName: string;
  label?: string;
  /** The answer, while the reader cannot see its answer row. */
  answer?: string;
  waitingOnYou?: boolean;
};

/**
 * Say where a question stands, from the question and the Inbox overlay
 * only: it waits on the viewer, it has an answer, or neither. Who else it
 * waits on, and a dismiss or a snooze, are Inbox facts that the transcript
 * does not read.
 */
function askStatus(
  question: ConversationQuestion,
  waitingOnYou: boolean,
  answerShown: boolean,
): AskStatus {
  const form = inboxItemQuestion(question.request);
  if (waitingOnYou) {
    return {
      icon: Inbox,
      iconClassName: "text-dashboard-accent-text",
      label: "Waiting on you",
      waitingOnYou: true,
    };
  }
  if (form && question.answer) {
    return {
      answer: answerShown ? undefined : answerLine(form, question.answer),
      icon: CircleCheck,
      iconClassName: "text-emerald-500",
      label: "Answered",
    };
  }
  return {
    icon: form ? Inbox : Info,
    iconClassName: "text-dashboard-text-muted",
  };
}

/**
 * Show the question that a tool call added as a card in the transcript. A
 * question that waits on the reader, as the Inbox's waiting read says,
 * stands out and shows its form, so the reader answers in place. On a
 * phone, a tap on it opens a sheet. Shows `fallback` when the viewer cannot
 * read the question.
 */
export function InboxItemAskRow(props: {
  ask: InboxItemAsk;
  conversationId: string;
  fallback: ReactNode;
}) {
  const { itemId } = props.ask;
  const { question, unavailable } = useConversationQuestion(
    props.conversationId,
    props.ask.questionId,
  );
  const { itemIds } = useViewerWaits();
  // The record repeats the answer only while its answer row is out of view.
  const answerShown = useAnswerInView(itemId);
  const waiting = Boolean(
    question &&
    !question.answer &&
    inboxItemQuestion(question.request) &&
    itemIds.has(itemId),
  );
  // The questions pill shows while a card is not in full view.
  const inViewRef = useQuestionInViewRef(itemId, waiting);
  // A phone keeps the record to its lines. A tap opens a waiting question
  // in a sheet, where its form has the room it needs.
  const mobile = useMobileLayout();
  const [sheet, setSheet] = useState(false);
  // A desktop shows the form in place, so a resize past a phone's width
  // closes the sheet. An answer elsewhere closes it too.
  if (sheet && !(mobile && waiting)) setSheet(false);
  if (unavailable) return props.fallback;
  if (!question) return null;
  const verb = inboxItemQuestion(question.request) ? "Asked" : "Added";
  const status = askStatus(question, waiting, answerShown);
  const Icon = status.icon;
  const item = waiting
    ? waitingQuestionItem(question, {
        conversationId: props.conversationId,
        itemId,
      })
    : undefined;
  return (
    // The transcript marks the card for a moment when the reader goes to it.
    <section
      aria-label={`${verb} ${inboxItemTitleText(question)}`}
      className={cn(
        "relative grid w-full min-w-0 gap-3 rounded-lg border px-3 py-2.5 font-sans text-sm transition-shadow duration-300 motion-reduce:transition-none data-highlighted:ring-2 data-highlighted:ring-violet-300/50",
        // A card with a form spans the transcript. A closed record is as
        // narrow as the other object rows.
        !(waiting && !mobile) && "max-w-[37.5rem]",
        status.waitingOnYou
          ? "border-violet-400/40 bg-violet-500/[0.07]"
          : "border-dashboard-border-subtle bg-dashboard-surface-panel",
      )}
      data-inbox-item-ask={itemId}
      ref={inViewRef}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md",
            status.waitingOnYou
              ? "bg-violet-500/15"
              : "bg-dashboard-fill-faint",
          )}
        >
          <Icon
            aria-hidden="true"
            className={cn("size-4", status.iconClassName)}
          />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {mobile && item ? (
            // The button covers the whole record, so a tap anywhere on it
            // opens the sheet.
            // The title truncates in its own span: a clipped button would
            // clip its cover too.
            <button
              aria-haspopup="dialog"
              className="flex min-w-0 cursor-pointer border-0 bg-transparent p-0 text-left font-medium text-dashboard-text underline decoration-dashboard-border-heavy underline-offset-2 after:absolute after:inset-0 after:rounded-[inherit] hover:decoration-current focus-visible:outline-dashboard-focus"
              onClick={() => setSheet(true)}
              type="button"
            >
              <span className="min-w-0 truncate">
                <InboxItemTitle item={question} />
              </span>
            </button>
          ) : (
            <QuestionPreview
              conversationId={props.conversationId}
              question={question}
              trigger={
                <Link
                  className="min-w-0 truncate font-medium text-dashboard-text no-underline hover:underline focus-visible:outline-dashboard-focus"
                  to={inboxItemPath(itemId)}
                />
              }
            >
              <InboxItemTitle item={question} />
            </QuestionPreview>
          )}
          {status.label ? (
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
                  <span
                    aria-hidden="true"
                    className="text-dashboard-text-faint"
                  >
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
          ) : null}
        </div>
      </div>
      {item && !mobile ? (
        <InboxItemActions
          context={<InboxItemTurnMessage item={item} />}
          item={item}
        />
      ) : null}
      {item && sheet && mobile ? (
        <InboxItemSheet
          context={<InboxItemTurnMessage item={item} />}
          item={item}
          onClose={() => setSheet(false)}
        />
      ) : null}
    </section>
  );
}
