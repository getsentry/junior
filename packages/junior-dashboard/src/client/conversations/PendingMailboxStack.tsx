import {
  memo,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { INPUT_IMAGE_TYPES } from "@sentry/junior/api/schema";
import {
  AlertCircle,
  Clock3,
  FileText,
  Pencil,
  SkipForward,
  Trash2,
  type LucideIcon,
} from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { ActorAvatar } from "../components/ActorAvatar";
import { ImageAttachment } from "../components/ImageAttachment";
import { ParticipantAvatar } from "../components/ParticipantAvatarStack";
import { Spinner } from "../components/ui/spinner";
import type { ConversationMailboxMessage } from "./conversationOutbox";
import { conversationAttachmentUrl } from "./TranscriptAttachment";
import {
  TranscriptHeadingMeta,
  TranscriptHeadingRow,
} from "./TranscriptHeadingRow";
import { SlackMark } from "./SlackMark";

const MAX_EXPANDED_PENDING_ROWS = 3;
const COLLAPSED_PENDING_ROW_COUNT = 2;

function pendingDeliveryMeta(
  message: Pick<ConversationMailboxMessage, "clientStatus" | "delivery">,
): { icon: LucideIcon | typeof Spinner; label: string } {
  if (message.clientStatus === "failed") {
    return { icon: AlertCircle, label: "Failed to send" };
  }
  if (message.clientStatus === "sending") {
    return { icon: Spinner, label: "Sending" };
  }
  if (message.delivery === "interrupt") {
    return { icon: SkipForward, label: "Interrupt" };
  }
  return { icon: Clock3, label: "Queued" };
}

function PendingMetaIcon(props: { children: ReactElement; label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={props.label}
            className="inline-flex text-dashboard-text-muted"
          >
            {props.children}
          </span>
        }
      />
      <TooltipContent>{props.label}</TooltipContent>
    </Tooltip>
  );
}

function PendingActionButton(props: {
  disabled: boolean;
  icon: LucideIcon;
  label: string;
  onClick(): void;
  pending: boolean;
  tooltip: string;
}) {
  const Icon = props.icon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-label={props.label}
            className="inline-flex size-5 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 text-dashboard-text-muted transition-colors hover:bg-dashboard-fill-hover hover:text-amber-50 focus-visible:outline focus-visible:outline-1 focus-visible:outline-amber-200/55 disabled:cursor-default disabled:opacity-50"
            disabled={props.disabled}
            onClick={props.onClick}
            type="button"
          >
            {props.pending ? (
              <Spinner aria-hidden="true" className="size-3.25" />
            ) : (
              <Icon aria-hidden="true" size={14} strokeWidth={2.2} />
            )}
          </button>
        }
      />
      <TooltipContent>{props.tooltip}</TooltipContent>
    </Tooltip>
  );
}

function PendingMetaIcons(props: {
  actionsDisabled: boolean;
  cancelError: boolean;
  cancelPending: boolean;
  editPending: boolean;
  message: ConversationMailboxMessage;
  onCancel?: () => void;
  onEdit?: () => void;
  onSteer?: () => void;
  showSlack: boolean;
  steerPending: boolean;
}) {
  const delivery = pendingDeliveryMeta(props.message);
  const DeliveryIcon = delivery.icon;

  return (
    <TranscriptHeadingMeta className="flex min-w-0 items-center justify-end gap-1.5 text-xs leading-none text-dashboard-text-muted">
      {props.showSlack ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="inline-flex text-dashboard-text-muted">
                <SlackMark className="size-3.5" />
              </span>
            }
          />
          <TooltipContent>Slack</TooltipContent>
        </Tooltip>
      ) : null}
      <PendingMetaIcon label={delivery.label}>
        <DeliveryIcon
          aria-hidden="true"
          className="size-3.25"
          strokeWidth={2.2}
        />
      </PendingMetaIcon>
      {props.onSteer ? (
        <PendingActionButton
          disabled={props.actionsDisabled}
          icon={SkipForward}
          label="Steer queued message"
          onClick={props.onSteer}
          pending={props.steerPending}
          tooltip="Steer: send it to Junior now"
        />
      ) : null}
      {props.onEdit ? (
        <PendingActionButton
          disabled={props.actionsDisabled}
          icon={Pencil}
          label="Edit queued message"
          onClick={props.onEdit}
          pending={props.editPending}
          tooltip="Edit queued message"
        />
      ) : null}
      {props.onCancel ? (
        <PendingActionButton
          disabled={props.actionsDisabled}
          icon={Trash2}
          label={
            props.cancelError
              ? "Could not delete. Try again."
              : "Delete queued message"
          }
          onClick={props.onCancel}
          pending={props.cancelPending}
          tooltip="Delete queued message"
        />
      ) : null}
    </TranscriptHeadingMeta>
  );
}

function PendingAuthorAvatar(props: { message: ConversationMailboxMessage }) {
  // Pending rows can come from web or Slack. Redacted rows hide the author.
  if (!props.message.actorIdentity) {
    return <ActorAvatar name="?" size="list" />;
  }
  return (
    <ParticipantAvatar participant={props.message.actorIdentity} size="list" />
  );
}

/** Show small previews so the reader can tell which images a queued message has. */
function PendingAttachmentThumbnails(props: {
  conversationId?: string;
  message: ConversationMailboxMessage;
}) {
  const thumbnailClassName = "size-6 rounded object-cover";
  const triggerClassName =
    "block size-6 flex-none overflow-hidden rounded border border-dashboard-border bg-dashboard-fill-faint transition-colors hover:border-dashboard-border-interactive focus-visible:outline-2 focus-visible:outline-dashboard-focus";
  const localImages = props.message.images ?? [];
  const attachments = props.message.attachments ?? [];
  if (localImages.length === 0 && attachments.length === 0) return null;

  return (
    <span className="flex flex-none items-center gap-1">
      {localImages.map((image, index) => (
        <ImageAttachment
          filename={image.filename}
          imageClassName={thumbnailClassName}
          key={`local:${index}`}
          src={`data:${image.contentType};base64,${image.data}`}
          triggerClassName={triggerClassName}
        />
      ))}
      {attachments.map((attachment) => {
        const isImage = INPUT_IMAGE_TYPES.some(
          (type) => type === attachment.contentType,
        );
        if (isImage && props.conversationId) {
          return (
            <ImageAttachment
              filename={attachment.filename}
              imageClassName={thumbnailClassName}
              key={attachment.id}
              loading="lazy"
              src={conversationAttachmentUrl(
                props.conversationId,
                attachment.id,
              )}
              triggerClassName={triggerClassName}
            />
          );
        }
        return (
          <PendingMetaIcon key={attachment.id} label={attachment.filename}>
            <FileText aria-hidden="true" size={14} />
          </PendingMetaIcon>
        );
      })}
    </span>
  );
}

function PendingRow(props: {
  actionsDisabled: boolean;
  cancelError: boolean;
  cancelPending: boolean;
  canEdit: boolean;
  canSteer: boolean;
  conversationId?: string;
  editPending: boolean;
  message: ConversationMailboxMessage;
  onCancel?(message: ConversationMailboxMessage): void;
  onEdit?(message: ConversationMailboxMessage): void;
  onRetry?(message: ConversationMailboxMessage): void;
  onSteer?(message: ConversationMailboxMessage): void;
  steerPending: boolean;
}) {
  const text = props.message.text ?? "";
  const redacted = Boolean(props.message.redacted);
  const showSlack = props.message.source === "slack";
  const canRetry =
    props.message.clientStatus === "failed" &&
    Boolean(props.message.idempotencyKey) &&
    Boolean(props.onRetry);

  return (
    <article className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 px-3 py-1.5 text-dashboard-text md:px-3.5">
      <TranscriptHeadingRow
        className="items-center"
        left={
          <>
            <PendingAuthorAvatar message={props.message} />
            {redacted ? null : (
              <PendingAttachmentThumbnails
                conversationId={props.conversationId}
                message={props.message}
              />
            )}
            {redacted ? (
              <p className="m-0 font-sans text-sm leading-snug text-dashboard-text-muted">
                [redacted]
              </p>
            ) : text ? (
              // One line keeps the queue short. The title shows the full text.
              <p
                className="m-0 min-w-0 truncate font-sans text-sm leading-snug text-dashboard-text-subtle"
                title={text}
              >
                {text}
              </p>
            ) : null}
          </>
        }
        leftClassName="flex-1 text-sm leading-snug text-dashboard-text"
        right={
          <PendingMetaIcons
            actionsDisabled={props.actionsDisabled}
            cancelError={props.cancelError}
            cancelPending={props.cancelPending}
            editPending={props.editPending}
            message={props.message}
            onCancel={
              props.onCancel ? () => props.onCancel?.(props.message) : undefined
            }
            onEdit={
              props.canEdit && props.onEdit
                ? () => props.onEdit?.(props.message)
                : undefined
            }
            onSteer={
              props.canSteer && props.onSteer
                ? () => props.onSteer?.(props.message)
                : undefined
            }
            showSlack={showSlack}
            steerPending={props.steerPending}
          />
        }
      />
      {canRetry ? (
        <div className="flex min-w-0 items-center gap-2">
          <p className="m-0 font-sans text-xs text-red-300/80">
            Could not send.
          </p>
          <button
            className="cursor-pointer border-0 bg-transparent p-0 font-sans text-xs font-medium text-dashboard-accent-text/90 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-dashboard-focus"
            onClick={() => props.onRetry?.(props.message)}
            type="button"
          >
            Retry
          </button>
        </div>
      ) : null}
      {props.cancelError ? (
        <p className="m-0 font-sans text-xs text-amber-100/75">
          Could not delete. Try again.
        </p>
      ) : null}
    </article>
  );
}

function ExpandQueuedMessagesButton(props: {
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
  const mobileCollapsedLabel = totalLabel;
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

function sameEmail(left: string | undefined, right: string | undefined) {
  return Boolean(
    left && right && left.trim().toLowerCase() === right.trim().toLowerCase(),
  );
}

/** Render accepted mailbox rows as a compact stack attached above the composer. */
export const PendingMailboxStack = memo(function PendingMailboxStack(props: {
  cancelError?: boolean;
  cancelPending?: boolean;
  cancelTargetInboundMessageId?: string;
  /** Message ids already present in committed history. */
  committedMessageIds?: readonly string[];
  /** Conversation that owns stored attachment previews. */
  conversationId?: string;
  /** Inbound id of the row that an edit is taking out of the queue. */
  editTargetInboundMessageId?: string;
  messages: readonly ConversationMailboxMessage[];
  onCancelMessage?: (message: ConversationMailboxMessage) => void;
  /** Take the viewer's own queued web message back into the composer. */
  onEditMessage?: (message: ConversationMailboxMessage) => void;
  /** Fires after expand/collapse changes the stack height above the composer. */
  onLayoutChange?: () => void;
  onRetry?(message: ConversationMailboxMessage): void;
  /** Ask Junior to read the viewer's own queued web message now. */
  onSteerMessage?: (message: ConversationMailboxMessage) => void;
  /** Inbound id of the row that a steer is sending now. */
  steerTargetInboundMessageId?: string;
  /** Email of the signed-in reader. Only their own web rows can be edited. */
  viewerEmail?: string;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const onLayoutChangeRef = useRef(props.onLayoutChange);
  onLayoutChangeRef.current = props.onLayoutChange;
  const hasMountedExpandedRef = useRef(false);
  // Expand/collapse changes footer height. Pin after layout so the transcript
  // scroll root already has the new client height.
  useLayoutEffect(() => {
    if (!hasMountedExpandedRef.current) {
      hasMountedExpandedRef.current = true;
      return;
    }
    onLayoutChangeRef.current?.();
  }, [expanded]);
  const committedIds = new Set(props.committedMessageIds ?? []);
  // Preserve mailbox order and clientStatus from the merged source rows.
  // History wins on messageId so a send does not appear twice once workers
  // persist the user message.
  const rows = props.messages.filter(
    (message) => !committedIds.has(message.messageId),
  );
  if (rows.length === 0) return null;

  const canCollapse = rows.length > MAX_EXPANDED_PENDING_ROWS;
  const showCollapsed = canCollapse && !expanded;
  const previewRows = rows.slice(0, COLLAPSED_PENDING_ROW_COUNT);
  const visibleRows = showCollapsed ? previewRows : rows;
  const hiddenCount = Math.max(0, rows.length - COLLAPSED_PENDING_ROW_COUNT);
  const toggleExpanded = () => setExpanded((value) => !value);
  const actionsDisabled =
    Boolean(props.cancelPending) ||
    Boolean(props.editTargetInboundMessageId) ||
    Boolean(props.steerTargetInboundMessageId);
  const renderRow = (message: ConversationMailboxMessage) => {
    const isTarget =
      props.cancelTargetInboundMessageId === message.inboundMessageId;
    // Only accepted server rows can leave the queue. Local rows are still sending.
    const accepted = message.clientStatus === undefined;
    const ownWebRow =
      accepted &&
      message.source === "web" &&
      !message.redacted &&
      sameEmail(message.actorIdentity?.email, props.viewerEmail);
    return (
      <PendingRow
        actionsDisabled={actionsDisabled}
        cancelError={Boolean(props.cancelError && isTarget)}
        cancelPending={Boolean(props.cancelPending && isTarget)}
        canEdit={ownWebRow}
        canSteer={ownWebRow && message.delivery === "defer"}
        conversationId={props.conversationId}
        editPending={
          props.editTargetInboundMessageId === message.inboundMessageId
        }
        key={message.messageId}
        message={message}
        onCancel={accepted ? props.onCancelMessage : undefined}
        onEdit={props.onEditMessage}
        onRetry={props.onRetry}
        onSteer={props.onSteerMessage}
        steerPending={
          props.steerTargetInboundMessageId === message.inboundMessageId
        }
      />
    );
  };

  return (
    <div
      aria-label="Pending messages"
      className="mx-2 overflow-hidden rounded-t-lg bg-amber-300/[0.055] md:mx-3"
    >
      {showCollapsed ? (
        // Desktop keeps a two-row preview; mobile collapses to the control only.
        <div className="hidden md:block">{previewRows.map(renderRow)}</div>
      ) : (
        visibleRows.map(renderRow)
      )}
      {canCollapse ? (
        <ExpandQueuedMessagesButton
          expanded={expanded}
          hiddenCount={hiddenCount}
          onClick={toggleExpanded}
          totalCount={rows.length}
        />
      ) : null}
    </div>
  );
});
