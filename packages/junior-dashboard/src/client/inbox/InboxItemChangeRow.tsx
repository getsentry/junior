import {
  CircleCheck,
  CircleSlash,
  Clock3,
  Inbox,
  Info,
  type LucideIcon,
} from "lucide-react";
import { use, useState, type ReactElement, type ReactNode } from "react";
import { Link } from "react-router";
import type {
  InboxItemChangeRecord,
  InboxItemPayload,
} from "@sentry/junior/api/schema";

import { HoverPreview } from "../components/ui/hover-preview";
import { cn, dashboardMessageCardClass } from "../styles";
import {
  TranscriptShowQuestion,
  useAnswerInView,
  useAnswerLinked,
} from "../conversations/TranscriptAnswerLinks";
import { DisplayText } from "../display-text/DisplayText";
import { useMobileLayout } from "../layoutMedia";
import { useConversationInboxItemData } from "./queries";
import { AnswerSummary, InboxItemActions } from "./InboxItemActions";
import { InboxItemObjects } from "./InboxItemObjects";
import { InboxItemSheet } from "./InboxItemSheet";
import {
  InboxItemAssignees,
  InboxItemCloser,
  InboxItemTitle,
} from "./InboxItemPeople";
import { InboxItemTurnMessage } from "./InboxItemTurnMessage";
import { useQuestionInViewRef } from "./WaitingQuestions";
import {
  answerLine,
  answerRows,
  itemConversationId,
  inboxItemPath,
  inboxItemTitleText,
  inboxItemWaitsForAnswer,
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
 * Show what an item asked, and its answer, when the reader hovers or focuses
 * its title. A transcript record names the item only by its title.
 */
function InboxItemPreview(props: {
  children: ReactNode;
  item: InboxItemPayload;
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
            <InboxItemTitle item={props.item} links />
          </p>
          {/* A notice or a plugin item has no question: its text is the ask. */}
          <InboxItemObjects conversationId={itemConversationId(props.item)}>
            <DisplayText
              mentions={props.item.mentions}
              text={request?.question ?? props.item.body}
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
  item: InboxItemPayload;
  record: InboxItemChangeRecord;
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
  // the Inbox, as does an item from another Conversation.
  const scrollsToQuestion =
    showQuestion !== undefined &&
    itemConversationId(item) === props.conversationId &&
    (askLinked || item.addedByTurnId !== undefined);
  return (
    <section
      aria-label={`${verb} ${inboxItemTitleText(item)}`}
      className="grid min-w-0 gap-1.5"
    >
      <p className="m-0 flex min-w-0 items-center gap-1.5 border-l-2 border-dashboard-border-emphasis pl-2 text-sm text-dashboard-text-muted">
        <span className="shrink-0">{verb}</span>
        <InboxItemPreview
          item={item}
          trigger={
            showQuestion && scrollsToQuestion ? (
              <button
                className={QUOTE_TITLE_CLASS}
                onClick={() => showQuestion(item)}
                type="button"
              />
            ) : (
              <Link className={QUOTE_TITLE_CLASS} to={inboxItemPath(item.id)} />
            )
          }
        >
          <InboxItemTitle item={item} />
        </InboxItemPreview>
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
 * Show the Inbox item change that a message records as one row: what the
 * message did and the item it did it to. The row shows the change from the
 * message, not the item's current state, so a take stays a take after a
 * later answer. Shows `fallback` when the viewer cannot read the item.
 */
export function InboxItemChangeRow(props: {
  conversationId: string;
  fallback: ReactNode;
  record: InboxItemChangeRecord;
}) {
  const { data, isError } = useConversationInboxItemData(
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
 * Name the Inbox item change that a queued message records, on one line.
 * Shows `fallback` until the item loads or when the viewer cannot read it.
 */
export function InboxItemChangeLabel(props: {
  conversationId: string;
  fallback: ReactNode;
  record: InboxItemChangeRecord;
}) {
  const { data } = useConversationInboxItemData(
    props.conversationId,
    props.record.reviewItemId,
  );
  if (!data) return props.fallback;
  return (
    <>
      {CHANGE_VERBS[props.record.kind]}{" "}
      <span className="font-medium text-dashboard-text">
        <InboxItemTitle item={data} />
      </span>
    </>
  );
}

type AskStatus = {
  icon: LucideIcon;
  iconClassName: string;
  label: ReactNode;
  /** The answer, while the reader cannot see its answer row. */
  answer?: string;
  waitingOnYou?: boolean;
};

/** Say where an item stands: who it waits on, or how it closed and by whom. */
function askStatus(item: InboxItemPayload, answerShown: boolean): AskStatus {
  if (item.status === "open") {
    // The viewer snoozed it. It still waits on the others.
    if (item.snoozedByViewer) {
      return {
        icon: Clock3,
        iconClassName: "text-dashboard-text-faint",
        label: "Snoozed",
      };
    }
    if (item.kind === "notice") {
      return {
        icon: Info,
        iconClassName: "text-dashboard-text-muted",
        label: (
          <>
            Added for <InboxItemAssignees item={item} />
          </>
        ),
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
          label: (
            <>
              Waiting on <InboxItemAssignees item={item} />
            </>
          ),
        };
  }
  const by = item.closedBy ? (
    <>
      {" "}
      by <InboxItemCloser item={item} />
    </>
  ) : null;
  if (item.status === "dismissed") {
    return {
      icon: CircleSlash,
      iconClassName: "text-dashboard-text-faint",
      label: <>Dismissed{by}</>,
    };
  }
  return {
    answer:
      !answerShown && item.request && item.answer
        ? answerLine(item.request, item.answer)
        : undefined,
    icon: CircleCheck,
    iconClassName: "text-emerald-500",
    label: (
      <>
        {item.answer ? "Answered" : "Done"}
        {by}
      </>
    ),
  };
}

/**
 * Show the Inbox item that a tool call added as a card in the transcript:
 * the title, where it stands, and the answer. A question that waits on the
 * reader stands out and shows its question and form, as its Inbox card
 * does, so the reader answers in place. On a phone, the record keeps to its
 * lines, and a tap opens the item in a sheet (`InboxItemSheet`). Shows
 * `fallback` when the viewer cannot read the item.
 */
export function InboxItemAskRow(props: {
  conversationId: string;
  fallback: ReactNode;
  itemId: string;
}) {
  const { data: item, isError } = useConversationInboxItemData(
    props.conversationId,
    props.itemId,
  );
  // The record repeats the answer only while its answer row is out of view.
  const answerShown = useAnswerInView(props.itemId);
  // Only a question from this Conversation shows its form here. Another
  // Conversation's question is answered there, or in the Inbox.
  const waiting = Boolean(
    item &&
    inboxItemWaitsForAnswer(item) &&
    itemConversationId(item) === props.conversationId,
  );
  // The questions pill shows while a card is not in full view.
  const inViewRef = useQuestionInViewRef(props.itemId, waiting);
  // A phone keeps the record to its lines. A tap opens the item in a sheet,
  // where its form has the room it needs.
  const mobile = useMobileLayout();
  const [sheet, setSheet] = useState(false);
  if (isError) return props.fallback;
  if (!item) return null;
  const verb = item.kind === "action" ? "Asked" : "Added";
  const status = askStatus(item, answerShown);
  const Icon = status.icon;
  return (
    // The transcript marks the card for a moment when the reader goes to it.
    <section
      aria-label={`${verb} ${inboxItemTitleText(item)}`}
      className={cn(
        "relative grid w-full min-w-0 gap-3 rounded-lg border px-3 py-2.5 font-sans text-sm transition-shadow duration-300 motion-reduce:transition-none data-highlighted:ring-2 data-highlighted:ring-violet-300/50",
        // A card with a form spans the transcript. A closed record is as
        // narrow as the other object rows.
        !(waiting && !mobile) && "max-w-[37.5rem]",
        status.waitingOnYou
          ? "border-violet-400/40 bg-violet-500/[0.07]"
          : "border-dashboard-border-subtle bg-dashboard-surface-panel",
      )}
      data-inbox-item-ask={item.id}
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
          {mobile ? (
            // The button covers the whole record, so a tap anywhere on it
            // opens the sheet.
            <button
              aria-haspopup="dialog"
              className={cn(
                QUOTE_TITLE_CLASS,
                "after:absolute after:inset-0 after:rounded-[inherit]",
                item.status === "dismissed" && "text-dashboard-text-muted",
              )}
              onClick={() => setSheet(true)}
              type="button"
            >
              <InboxItemTitle item={item} />
            </button>
          ) : (
            <InboxItemPreview
              item={item}
              trigger={
                <Link
                  className={cn(
                    "min-w-0 truncate font-medium no-underline hover:underline focus-visible:outline-dashboard-focus",
                    item.status === "dismissed"
                      ? "text-dashboard-text-muted"
                      : "text-dashboard-text",
                  )}
                  to={inboxItemPath(item.id)}
                />
              }
            >
              <InboxItemTitle item={item} />
            </InboxItemPreview>
          )}
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
      </div>
      {waiting && !mobile ? (
        <InboxItemActions
          context={<InboxItemTurnMessage item={item} />}
          item={item}
        />
      ) : null}
      {sheet ? (
        <InboxItemSheet
          context={waiting ? <InboxItemTurnMessage item={item} /> : undefined}
          item={item}
          onClose={() => setSheet(false)}
        />
      ) : null}
    </section>
  );
}
