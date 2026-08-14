import { useState, type ReactElement, type ReactNode } from "react";
import {
  AlertCircle,
  Clock3,
  LoaderCircle,
  SkipForward,
  type LucideIcon,
} from "lucide-react";

import { Button } from "../components/Button";
import { Tooltip } from "../components/Tooltip";
import { transcriptMessageActorLabel } from "../format";
import type { ConversationTranscript, TranscriptViewMessage } from "../types";
import type { ConversationMailboxMessage } from "./conversationOutbox";
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
  message: Pick<ConversationMailboxMessage, "clientStatus" | "delivery">,
): { icon: LucideIcon; label: string; spin?: boolean } {
  if (message.clientStatus === "failed") {
    return { icon: AlertCircle, label: "Failed to send" };
  }
  if (message.clientStatus === "sending") {
    return { icon: LoaderCircle, label: "Sending", spin: true };
  }
  if (message.delivery === "interrupt") {
    return { icon: SkipForward, label: "Interrupt" };
  }
  return { icon: Clock3, label: "Queued" };
}

function PendingMetaIcon(props: { children: ReactElement; label: string }) {
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
  message: ConversationMailboxMessage;
  showSlack: boolean;
}) {
  const delivery = pendingDeliveryMeta(props.message);
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
        <DeliveryIcon
          aria-hidden="true"
          className={delivery.spin ? "animate-spin" : undefined}
          size={13}
          strokeWidth={2.2}
        />
      </PendingMetaIcon>
    </TranscriptHeadingMeta>
  );
}

function PendingRow(props: {
  conversation: ConversationTranscript;
  message: ConversationMailboxMessage;
  onRetry?(message: ConversationMailboxMessage): void;
}) {
  const text = props.message.text ?? "";
  const redacted = Boolean(props.message.redacted);
  const projected: TranscriptViewMessage = {
    actorIdentity: props.message.actorIdentity,
    delivery: props.message.delivery,
    messageId: props.message.messageId,
    parts: redacted
      ? [{ type: "text", redacted: true }]
      : [{ type: "text", text }],
    pending: true,
    role: "user",
    source: props.message.source,
    sourceSeq: 0,
    timestamp: Date.parse(props.message.createdAt),
  };
  const roleLabel = transcriptMessageActorLabel(props.conversation, projected);
  const showSlack = showsSlackSourceIcon(projected, props.conversation);
  const canRetry =
    props.message.clientStatus === "failed" &&
    Boolean(props.message.idempotencyKey) &&
    Boolean(props.onRetry);

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
          <PendingMetaIcons message={props.message} showSlack={showSlack} />
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
      {canRetry ? (
        <div className="flex min-w-0 items-center gap-2">
          <p className="m-0 font-sans text-xs text-red-300/80">
            Could not send.
          </p>
          <button
            className="cursor-pointer border-0 bg-transparent p-0 font-sans text-xs font-medium text-cyan-200/90 underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-1 focus-visible:outline-cyan-300/55"
            onClick={() => props.onRetry?.(props.message)}
            type="button"
          >
            Retry
          </button>
        </div>
      ) : null}
    </article>
  );
}

function ExpandQueuedMessagesButton(props: {
  /** When the cancel bar already shows the total count, avoid repeating it on mobile. */
  countShownInCancelBar: boolean;
  expanded: boolean;
  hiddenCount: number;
  onClick(): void;
  totalCount: number;
}) {
  const totalLabel =
    props.totalCount === 1
      ? "1 queued message"
      : `${props.totalCount} queued messages`;
  const moreLabel =
    props.hiddenCount > 0
      ? `${props.hiddenCount} more queued messages`
      : totalLabel;
  // Mobile collapses previews and uses the total count as the expand control.
  // When cancel already owns that count, keep a distinct expand action label.
  const mobileCollapsedLabel = props.countShownInCancelBar
    ? "Show queued messages"
    : totalLabel;
  const label = props.expanded ? "Show fewer queued messages" : moreLabel;

  return (
    <button
      aria-expanded={props.expanded}
      className="w-full cursor-pointer border-0 bg-transparent px-3 py-2 text-left font-sans text-xs font-medium text-amber-100/80 transition-colors hover:text-amber-50 focus-visible:outline focus-visible:outline-1 focus-visible:outline-amber-200/55 md:px-3.5"
      onClick={props.onClick}
      type="button"
    >
      {props.expanded ? (
        label
      ) : (
        <>
          <span className="md:hidden">{mobileCollapsedLabel}</span>
          <span className="hidden md:inline">{moreLabel}</span>
        </>
      )}
    </button>
  );
}

/** Render accepted mailbox rows as a compact stack attached above the composer. */
export function PendingMailboxStack(props: {
  cancelError?: boolean;
  cancelPending?: boolean;
  conversation: ConversationTranscript;
  messages: readonly ConversationMailboxMessage[];
  onCancelQueue?: () => void;
  onRetry?(message: ConversationMailboxMessage): void;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const unresolvedIds = new Set(
    unresolvedPendingTranscriptMessages(
      conversationTranscriptMessages(props.conversation),
      props.messages,
    ).map((message) => message.messageId),
  );
  // Preserve mailbox order and clientStatus from the merged source rows.
  const rows = props.messages.filter((message) =>
    unresolvedIds.has(message.messageId),
  );
  if (rows.length === 0) return null;

  const canCollapse = rows.length > MAX_EXPANDED_PENDING_ROWS;
  const showCollapsed = canCollapse && !expanded;
  const previewRows = rows.slice(0, COLLAPSED_PENDING_ROW_COUNT);
  const visibleRows = showCollapsed ? previewRows : rows;
  const hiddenCount = Math.max(0, rows.length - COLLAPSED_PENDING_ROW_COUNT);
  const toggleExpanded = () => setExpanded((value) => !value);
  const cancellableCount = rows.filter(
    (message) => message.clientStatus === undefined,
  ).length;
  const hasSendingRow = rows.some(
    (message) => message.clientStatus === "sending",
  );
  const showCancel =
    cancellableCount > 0 && !hasSendingRow && Boolean(props.onCancelQueue);
  const countLabel =
    rows.length === 1 ? "1 queued message" : `${rows.length} queued messages`;

  return (
    <div
      aria-label="Pending messages"
      className="mx-2 overflow-hidden rounded-t-lg bg-amber-300/[0.055] md:mx-3"
    >
      {showCancel ? (
        <div className="flex items-center justify-between gap-2 px-3 py-2 md:px-3.5">
          <div className="min-w-0 font-sans text-xs font-medium text-amber-100/80">
            {countLabel}
          </div>
          <Button
            aria-label="Cancel queued messages"
            className="h-7 shrink-0 border-white/10 bg-transparent px-2 text-xs font-medium text-amber-100/85 hover:border-white/25 hover:bg-white/[0.06] hover:text-amber-50"
            disabled={props.cancelPending}
            onClick={props.onCancelQueue}
          >
            {props.cancelPending ? "Cancelling…" : "Cancel queue"}
          </Button>
        </div>
      ) : null}
      {showCancel && props.cancelError ? (
        <div className="border-t border-amber-300/15 px-3 py-1.5 font-sans text-xs text-amber-100/75 md:px-3.5">
          Could not cancel queued messages. Try again.
        </div>
      ) : null}
      {showCollapsed ? (
        // Desktop keeps a two-row preview; mobile collapses to the control only.
        <div className="hidden md:block">
          {previewRows.map((message, index) => (
            <PendingRow
              conversation={props.conversation}
              key={message.messageId ?? `${message.inboundMessageId}:${index}`}
              message={message}
              onRetry={props.onRetry}
            />
          ))}
        </div>
      ) : (
        visibleRows.map((message, index) => (
          <PendingRow
            conversation={props.conversation}
            key={message.messageId ?? `${message.inboundMessageId}:${index}`}
            message={message}
            onRetry={props.onRetry}
          />
        ))
      )}
      {canCollapse ? (
        <ExpandQueuedMessagesButton
          countShownInCancelBar={showCancel}
          expanded={expanded}
          hiddenCount={hiddenCount}
          onClick={toggleExpanded}
          totalCount={rows.length}
        />
      ) : null}
    </div>
  );
}
