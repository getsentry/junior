import { TranscriptAttachments } from "./TranscriptAttachment";
import { ObjectCard } from "./ObjectCard";
import { AutomationCard } from "../components/AutomationCard";
import { memo, type ReactNode } from "react";

import {
  formatMessageTimestamp,
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
import { SlackMark } from "./SlackMark";
import { TranscriptText } from "./TranscriptText";
import { TranscriptTurnContextView } from "./TranscriptTurnContextView";
import { TranscriptTimestamp } from "./TranscriptTimestamp";
import { showsSlackSourceIcon } from "./transcriptSource";

/** Render one chat message with its saved cards and attached turn context. */
export const TranscriptMessageView = memo(
  function TranscriptMessageView(props: {
    message: TranscriptViewMessage;
    conversation: ConversationTranscript;
  }) {
    const rawText = messageRawText(props.message);
    const role = props.message.role;

    return (
      <TranscriptMessageShell
        role={props.message.role}
        actor={transcriptMessageActorLabel(props.conversation, props.message)}
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
          contextAction={
            props.message.role === "user" && props.message.contexts?.length ? (
              <TranscriptTurnContextView contexts={props.message.contexts} />
            ) : undefined
          }
          message={props.message}
          conversation={props.conversation}
        />
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
          {props.message.parts.map((part, index) =>
            part.type === "text" ? (
              <TranscriptText key={index} role={role} text={part.text ?? ""} />
            ) : null,
          )}
        </div>
        {props.message.attachments?.length ? (
          <TranscriptAttachments
            attachments={props.message.attachments}
            conversationId={props.conversation.conversationId}
          />
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
      </TranscriptMessageShell>
    );
  },
  (previous, next) =>
    previous.message === next.message &&
    previous.conversation.conversationId === next.conversation.conversationId &&
    previous.conversation.surface === next.conversation.surface &&
    previous.conversation.actorIdentity === next.conversation.actorIdentity,
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

function TranscriptMessageHeader(props: {
  contextAction?: ReactNode;
  message: TranscriptViewMessage;
  conversation: ConversationTranscript;
}) {
  const showSlack = showsSlackSourceIcon(props.message, props.conversation);
  const timestamp = formatMessageTimestamp(props.message.timestamp);
  const roleLabel = transcriptMessageActorLabel(
    props.conversation,
    props.message,
  );

  return (
    <TranscriptMessageHeading action={props.contextAction}>
      <span className={transcriptRoleLabelClass(props.message.role)}>
        {roleLabel}
      </span>
      {showSlack || timestamp ? (
        <span className="inline-flex max-w-full flex-wrap items-baseline gap-x-1.5 text-xs leading-6 text-dashboard-text-muted">
          {showSlack ? (
            <span className="inline-flex shrink-0 self-center" title="Slack">
              <SlackMark className="size-3.5" />
            </span>
          ) : null}
          {showSlack && timestamp ? <span aria-hidden="true">·</span> : null}
          {props.message.role === "assistant" ? (
            <TranscriptTimestamp value={props.message.timestamp} />
          ) : (
            timestamp
          )}
        </span>
      ) : null}
    </TranscriptMessageHeading>
  );
}

function transcriptRoleLabelClass(role: string): string {
  const kind = transcriptRoleKind(role);

  return cn(
    "inline-block max-w-full truncate font-sans text-sm font-semibold leading-6",
    kind === "assistant" && "text-cyan-100",
    kind === "user" && "text-dashboard-text",
    kind === "system" && "text-amber-200",
    kind === "tool" && "text-dashboard-text-muted",
    kind === "other" && "text-dashboard-text",
  );
}
