import type { ReactElement, ReactNode } from "react";
import { Clock3, SkipForward, X, type LucideIcon } from "lucide-react";
import type { ConversationPendingMessage } from "@sentry/junior/api/schema";

import { cn } from "../styles";
import { ShimmerText } from "../components/ShimmerText";
import { Tooltip } from "../components/Tooltip";
import { formatMessageTimestamp, transcriptMessageActorLabel } from "../format";
import type { ConversationTranscript, TranscriptViewMessage } from "../types";
import {
  TranscriptHeadingMeta,
  TranscriptHeadingRow,
} from "./TranscriptHeadingRow";
import {
  conversationTranscriptMessages,
  unresolvedPendingTranscriptMessages,
} from "./eventTranscript";

const MAX_EXPANDED_PENDING_ROWS = 3;
const COLLAPSED_PENDING_ROW_COUNT = 2;

/** Compact monochrome Slack mark for pending mailbox source. */
function SlackMark(props: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={props.className}
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <path d="M6.2 15.3c0 1.4-1.1 2.5-2.5 2.5S1.2 16.7 1.2 15.3s1.1-2.5 2.5-2.5h2.5v2.5zm1.3 0c0-1.4 1.1-2.5 2.5-2.5s2.5 1.1 2.5 2.5v6.2c0 1.4-1.1 2.5-2.5 2.5s-2.5-1.1-2.5-2.5v-6.2zM8.7 6.2c-1.4 0-2.5-1.1-2.5-2.5S7.3 1.2 8.7 1.2s2.5 1.1 2.5 2.5v2.5H8.7zm0 1.3c1.4 0 2.5 1.1 2.5 2.5s-1.1 2.5-2.5 2.5H2.5C1.1 12.5 0 11.4 0 10s1.1-2.5 2.5-2.5h6.2zM17.8 8.7c0-1.4 1.1-2.5 2.5-2.5s2.5 1.1 2.5 2.5-1.1 2.5-2.5 2.5h-2.5V8.7zm-1.3 0c0 1.4-1.1 2.5-2.5 2.5s-2.5-1.1-2.5-2.5V2.5C11.5 1.1 12.6 0 14 0s2.5 1.1 2.5 2.5v6.2zM14 17.8c1.4 0 2.5 1.1 2.5 2.5s-1.1 2.5-2.5 2.5-2.5-1.1-2.5-2.5v-2.5H14zm0-1.3c-1.4 0-2.5-1.1-2.5-2.5s1.1-2.5 2.5-2.5h6.2c1.4 0 2.5 1.1 2.5 2.5s-1.1 2.5-2.5 2.5H14z" />
    </svg>
  );
}

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
  className?: string;
  label: string;
}) {
  return (
    <Tooltip content={props.label} placement="above">
      <span
        aria-label={props.label}
        className={cn("inline-flex", props.className)}
      >
        {props.children}
      </span>
    </Tooltip>
  );
}

function PendingMetaIcons(props: {
  delivery: ConversationPendingMessage["delivery"];
  source: ConversationPendingMessage["source"];
  timestamp?: string;
}) {
  const delivery = pendingDeliveryMeta(props.delivery);
  const DeliveryIcon = delivery.icon;
  const showSlack = props.source === "slack";

  return (
    <TranscriptHeadingMeta className="flex min-w-0 items-center justify-end gap-2 text-xs leading-none text-dashboard-text-muted">
      <span className="inline-flex shrink-0 items-center gap-1.5">
        {showSlack ? (
          <PendingMetaIcon className="text-dashboard-text-muted" label="Slack">
            <SlackMark className="size-3.5" />
          </PendingMetaIcon>
        ) : null}
        <PendingMetaIcon
          className={
            props.delivery === "interrupt"
              ? "text-amber-200/85"
              : "text-dashboard-text-muted"
          }
          label={delivery.label}
        >
          <DeliveryIcon aria-hidden="true" size={13} strokeWidth={2.2} />
        </PendingMetaIcon>
      </span>
      {props.timestamp ? (
        <span className="min-w-0 truncate">{props.timestamp}</span>
      ) : null}
    </TranscriptHeadingMeta>
  );
}

function PendingRow(props: {
  canceling: boolean;
  conversation: ConversationTranscript;
  message: TranscriptViewMessage;
  onCancel: () => void;
  showDivider: boolean;
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
  const source =
    props.message.source ??
    (props.conversation.surface === "slack" ? "slack" : "web");

  return (
    <article
      className={cn(
        "grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 px-3 py-2 text-dashboard-text md:px-3.5",
        props.showDivider && "border-t border-white/[0.06]",
      )}
    >
      <TranscriptHeadingRow
        left={
          <span className="inline-block max-w-full truncate font-display text-sm font-semibold leading-tight text-dashboard-text">
            <ShimmerText active>{roleLabel}</ShimmerText>
          </span>
        }
        leftClassName="text-sm leading-snug text-dashboard-text"
        right={
          <span className="flex items-center gap-2">
            <PendingMetaIcons
              delivery={delivery}
              source={source}
              timestamp={formatMessageTimestamp(props.message.timestamp)}
            />
            <Tooltip content="Cancel queued message" placement="above">
              <button
                aria-label="Cancel queued message"
                className="-m-1 inline-flex size-6 shrink-0 items-center justify-center rounded text-dashboard-text-muted transition-colors hover:bg-white/[0.08] hover:text-dashboard-text disabled:cursor-wait disabled:opacity-50"
                disabled={props.canceling}
                onClick={props.onCancel}
                type="button"
              >
                <X aria-hidden="true" size={14} strokeWidth={2.2} />
              </button>
            </Tooltip>
          </span>
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
  cancelingMessageId?: string;
  messages: readonly ConversationPendingMessage[];
  onCancel: (inboundMessageId: string) => void;
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
      className="mx-2 overflow-hidden rounded-t-lg border border-b-0 border-white/[0.09] bg-cyan-300/[0.07] md:mx-3"
    >
      <div className="px-3 py-2 font-sans text-xs font-medium text-cyan-50/85 md:hidden">
        {countLabel}
      </div>
      <div className="hidden md:block">
        {visibleRows.map((message, index) => {
          const pendingMessage = props.messages.find(
            (candidate) => candidate.messageId === message.messageId,
          );
          if (!pendingMessage) return null;
          return (
            <PendingRow
              canceling={
                props.cancelingMessageId === pendingMessage.inboundMessageId
              }
              conversation={props.conversation}
              key={message.messageId ?? `${message.sourceSeq}:${index}`}
              message={message}
              onCancel={() => props.onCancel(pendingMessage.inboundMessageId)}
              showDivider={index > 0}
            />
          );
        })}
        {collapsedCount > 0 ? (
          <div className="border-t border-white/[0.06] px-3 py-2 font-sans text-xs font-medium text-cyan-50/70 md:px-3.5">
            {collapsedCount} more queued messages
          </div>
        ) : null}
      </div>
    </div>
  );
}
