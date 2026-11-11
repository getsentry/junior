import { ForkConversationButton } from "./ForkConversationButton";
import {
  TranscriptAttachments,
  TranscriptLocalFiles,
} from "./TranscriptAttachment";
import { ObjectCard } from "./ObjectCard";
import { AutomationCard } from "../components/AutomationCard";
import { CopyButton } from "../components/CopyButton";
import { MessageActions } from "../components/ui/message";
import { ReplyRatingActions } from "./ReplyRatingActions";
import { ReviewItemChangeRow } from "../review-desk/ReviewItemChangeRow";
import { memo, type ReactNode } from "react";

import {
  formatMessageTimestamp,
  transcriptMessageActor,
  transcriptMessageActorLabel,
  transcriptRoleKind,
} from "../format";
import { cn } from "../styles";
import { TranscriptMessageShell } from "./TranscriptMessageShell";
import type { ConversationTranscript, TranscriptViewMessage } from "../types";
import { shouldCopyRawTranscript } from "./transcriptCopy";
import { messageRawText } from "./transcriptRenderModel";
import { TranscriptMessageHeading } from "./TranscriptHeadingRow";
import { RedactedMarker } from "./TranscriptRedacted";
import { SourceMark } from "./SourceMark";
import { DisplayText } from "../display-text/DisplayText";
import { TranscriptTurnContextView } from "./TranscriptTurnContextView";
import { TranscriptRecalledMemories } from "./TranscriptMemoryPopover";
import { TranscriptTimestamp } from "./TranscriptTimestamp";
import { transcriptMessageSource } from "./transcriptSource";

/** Render one chat message with its saved cards and attached turn context. */
export const TranscriptMessageView = memo(
  function TranscriptMessageView(props: {
    message: TranscriptViewMessage;
    conversation: ConversationTranscript;
  }) {
    const rawText = messageRawText(props.message);
    const roleKind = transcriptRoleKind(props.message.role);
    const chatText = roleKind === "assistant" || roleKind === "user";
    const forkMessageId = canForkAfter(props.message, props.conversation)
      ? props.message.messageId
      : undefined;
    const text = (
      <div
        className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2"
        // `QuickQuestion` reads it: selections here can start a question.
        data-quick-question-message-id={forkMessageId}
      >
        {props.message.parts.map((part, index) =>
          part.type === "text" ? (
            <DisplayText
              chat={chatText}
              key={index}
              mentions={props.message.mentions}
              text={part.text ?? ""}
            />
          ) : null,
        )}
      </div>
    );

    return (
      <TranscriptMessageShell
        role={props.message.role}
        actor={transcriptMessageActorLabel(props.conversation, props.message)}
        fromAgent={Boolean(props.message.agentInvocationId)}
        avatarUrl={
          transcriptMessageActor(props.conversation, props.message)?.avatarUrl
        }
        onCopy={(event) => {
          const selection = event.currentTarget.ownerDocument.getSelection();
          if (
            !shouldCopyRawTranscript(rawText, selection, event.currentTarget)
          ) {
            return;
          }
          event.clipboardData.setData("text/plain", rawText);
          event.preventDefault();
        }}
      >
        <TranscriptMessageHeader
          action={turnContextAction(props.message, props.conversation)}
          message={props.message}
          conversation={props.conversation}
        />
        {props.message.reviewItemChanges?.length
          ? props.message.reviewItemChanges.map((record, index) => (
              <ReviewItemChangeRow
                conversationId={props.conversation.conversationId}
                fallback={text}
                key={index}
                record={record}
              />
            ))
          : text}
        <TranscriptRecalledMemories message={props.message} />
        {props.message.attachments?.length ? (
          <TranscriptAttachments
            attachments={props.message.attachments}
            conversationId={props.conversation.conversationId}
          />
        ) : null}
        {props.message.files?.length ? (
          <TranscriptLocalFiles files={props.message.files} />
        ) : null}
        {props.message.cards?.map((card) => {
          switch (card.kind) {
            case "object":
              return (
                <ObjectCard key={`${card.plugin}:${card.key}`} card={card} />
              );
            case "automation":
              return (
                <AutomationCard key={`${card.kind}:${card.id}`} card={card} />
              );
          }
        })}
        {roleKind === "assistant" &&
        !props.message.pending &&
        (rawText || forkMessageId) ? (
          // The margins line the first icon up with the text edge and let the
          // icon padding use the space that is already around the message.
          <MessageActions className="-mt-1.5 -mb-2.5 -ml-2 [&>button]:size-8">
            {rawText ? (
              <CopyButton getText={() => rawText} label="Copy message" />
            ) : null}
            {forkMessageId ? (
              <ForkConversationButton
                conversationId={props.conversation.conversationId}
                messageId={forkMessageId}
              />
            ) : null}
            {props.message.messageId ? (
              <ReplyRatingActions
                conversationId={props.conversation.conversationId}
                messageId={props.message.messageId}
              />
            ) : null}
          </MessageActions>
        ) : null}
      </TranscriptMessageShell>
    );
  },
  (previous, next) =>
    previous.message === next.message &&
    previous.conversation.conversationId === next.conversation.conversationId &&
    previous.conversation.surface === next.conversation.surface &&
    previous.conversation.canFork === next.conversation.canFork &&
    previous.conversation.actorIdentity === next.conversation.actorIdentity &&
    previous.conversation.authors === next.conversation.authors,
);

/** Render a redacted primary chat message without exposing body content. */
export function RedactedMessageView(props: {
  message: TranscriptViewMessage;
  conversation: ConversationTranscript;
}) {
  return (
    <TranscriptMessageShell
      role={props.message.role}
      actor={transcriptMessageActorLabel(props.conversation, props.message)}
      fromAgent={Boolean(props.message.agentInvocationId)}
      avatarUrl={
        transcriptMessageActor(props.conversation, props.message)?.avatarUrl
      }
    >
      <TranscriptMessageHeader
        message={props.message}
        conversation={props.conversation}
      />
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 font-mono text-base leading-snug text-dashboard-text-muted">
        {props.message.parts.map((_part, index) => (
          <div className="py-1" key={index}>
            <RedactedMarker />
          </div>
        ))}
      </div>
    </TranscriptMessageShell>
  );
}

function turnContextAction(
  message: TranscriptViewMessage,
  conversation: ConversationTranscript,
): ReactNode {
  if (message.role !== "user" || !message.contexts?.length) return undefined;
  return (
    <TranscriptTurnContextView
      actor={transcriptMessageActor(conversation, message)}
      contexts={message.contexts}
      messageId={message.messageId}
      timestamp={message.timestamp}
    />
  );
}

/** A delivered Junior reply ends the history of a fork or Quick question. */
function canForkAfter(
  message: TranscriptViewMessage,
  conversation: ConversationTranscript,
): message is TranscriptViewMessage & { messageId: string } {
  return Boolean(
    conversation.canFork &&
    message.role === "assistant" &&
    message.messageId &&
    !message.pending,
  );
}

function TranscriptMessageHeader(props: {
  action?: ReactNode;
  message: TranscriptViewMessage;
  conversation: ConversationTranscript;
}) {
  const source = transcriptMessageSource(props.message, props.conversation);
  const timestamp = formatMessageTimestamp(props.message.timestamp);
  const roleLabel = transcriptMessageActorLabel(
    props.conversation,
    props.message,
  );

  return (
    <TranscriptMessageHeading action={props.action}>
      <span className={transcriptRoleLabelClass(props.message.role)}>
        {roleLabel}
      </span>
      {source || timestamp ? (
        <span className="inline-flex max-w-full flex-wrap items-baseline gap-x-1.5 text-xs leading-6 text-dashboard-text-muted">
          {source ? <SourceMark provider={source} /> : null}
          {source && timestamp ? <span aria-hidden="true">·</span> : null}
          <TranscriptTimestamp value={props.message.timestamp} />
        </span>
      ) : null}
    </TranscriptMessageHeading>
  );
}

function transcriptRoleLabelClass(role: string): string {
  const kind = transcriptRoleKind(role);

  return cn(
    "inline-block max-w-full truncate font-sans text-sm font-semibold leading-6",
    kind === "assistant" && "text-dashboard-accent-text",
    kind === "user" && "text-dashboard-text",
    kind === "system" && "text-amber-200",
    kind === "tool" && "text-dashboard-text-muted",
    kind === "other" && "text-dashboard-text",
  );
}
