import type { ReactElement, ReactNode } from "react";
import { Clock3, SkipForward, type LucideIcon } from "lucide-react";
import type { ConversationPendingMessage } from "@sentry/junior/api/schema";

import { Tooltip } from "../components/Tooltip";
import { transcriptMessageActorLabel } from "../format";
import type { ConversationTranscript, TranscriptViewMessage } from "../types";
import {
  TranscriptHeadingMeta,
  TranscriptHeadingRow,
} from "./TranscriptHeadingRow";
import {
  conversationTranscriptMessages,
  unresolvedPendingTranscriptMessages,
} from "./eventTranscript";
import { SlackMark } from "./SlackMark";
import { showsSlackSourceIcon } from "./transcriptSource";

const MAX_EXPANDED_PENDING_ROWS = 3;
const COLLAPSED_PENDING_ROW_COUNT = 2;

function pendingDeliveryMeta(
  delivery: ConversationPendingMessage["delivery"],
): { icon: LucideIcon; label: string } {
  if (delivery === "interrupt") {
    return { icon: SkipForward, label: "Interrupt" };
  }
  return { icon: Clock3, label: "Queued" };
}

function PendingMetaIcon(props: {
  children: ReactElement;
  label: string;
}) {
  return (
    <Tooltip content={props.label} placement="above">
      <span
        aria-label={props.label}
        className="inline-flex text-dashboard-text-muted"
      >
        {props.children}
      </span>
    </Tooltip>
  );
}

function PendingMetaIcons(props: {
  delivery: ConversationPendingMessage["delivery"];
  showSlack: boolean;
}) {
  const delivery = pendingDeliveryMeta(props.delivery);
  const DeliveryIcon = delivery.icon;

  return (
    <TranscriptHeadingMeta className="flex min-w-0 items-center justify-end gap-1.5 text-xs leading-none text-dashboard-text-muted">
      {props.showSlack ? (
        <Tooltip content="Slack" placement="above">
          <span className="inline-flex text-dashboard-text-muted">
            <SlackMark className="size-3.5" />
          </span>
        </Tooltip>
      ) : null}
      <PendingMetaIcon label={delivery.label}>
        <DeliveryIcon aria-hidden="true" size={13} strokeWidth={2.2} />
      </PendingMetaIcon>
    </TranscriptHeadingMeta>
  );
}

function PendingRow(props: {
  conversation: ConversationTranscript;
  message: TranscriptViewMessage;
}) {
  const textPart = props.message.parts.find((part) => part.type === "text");
  const redacted = Boolean(
    textPart && "redacted" in textPart && textPart.redacted,
  );
  const text =
    textPart && "text" in textPart && typeof textPart.text === "string"
      ? textPart.text
      : "";
  const roleLabel = transcriptMessageActorLabel(
    props.conversation,
    props.message,
  );
  const delivery = props.message.delivery ?? "defer";
  const showSlack = showsSlackSourceIcon(props.message, props.conversation);

  return (
    <article className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 px-3 py-2 text-dashboard-text md:px-3.5">
      <TranscriptHeadingRow
        left={
          <span className="inline-block max-w-full truncate font-display text-sm font-semibold leading-tight text-dashboard-text">
            {roleLabel}
          </span>
        }
        leftClassName="text-sm leading-snug text-dashboard-text"
        right={
          <PendingMetaIcons delivery={delivery} showSlack={showSlack} />
        }
      />
      {redacted ? (
        <p className="m-0 font-mono text-sm leading-snug text-dashboard-text-muted">
          [redacted]
        </p>
      ) : (
        <p className="m-0 line-clamp-3 font-mono text-sm leading-snug text-dashboard-text/90">
          {text}
        </p>
      )}
    </article>
  );
}

/** Render accepted mailbox rows as a compact stack attached above the composer. */
export function PendingMailboxStack(props: {
  conversation: ConversationTranscript;
  messages: readonly ConversationPendingMessage[];
}): ReactNode {
  const rows = unresolvedPendingTranscriptMessages(
    conversationTranscriptMessages(props.conversation),
    props.messages,
  );
  if (rows.length === 0) return null;

  const countLabel =
    rows.length === 1 ? "1 queued message" : `${rows.length} queued messages`;
  const visibleRows =
    rows.length > MAX_EXPANDED_PENDING_ROWS
      ? rows.slice(0, COLLAPSED_PENDING_ROW_COUNT)
      : rows;
  const collapsedCount = rows.length - visibleRows.length;

  return (
    <div
      aria-label="Pending messages"
      className="mx-2 overflow-hidden rounded-t-lg bg-amber-300/[0.055] md:mx-3"
    >
      <div className="px-3 py-2 font-sans text-xs font-medium text-amber-100/80 md:hidden">
        {countLabel}
      </div>
      <div className="hidden md:block">
        {visibleRows.map((message, index) => (
          <PendingRow
            conversation={props.conversation}
            key={message.messageId ?? `${message.sourceSeq}:${index}`}
            message={message}
          />
        ))}
        {collapsedCount > 0 ? (
          <div className="px-3 py-2 font-sans text-xs font-medium text-amber-100/70 md:px-3.5">
            {collapsedCount} more queued messages
          </div>
        ) : null}
      </div>
    </div>
  );
}
