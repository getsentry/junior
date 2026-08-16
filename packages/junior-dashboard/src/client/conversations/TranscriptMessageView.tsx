import { memo, type ClipboardEventHandler, type ReactNode } from "react";

import { HighlightedCode } from "../code";
import {
  detectLanguage,
  formatMessageTimestamp,
  transcriptMessageActorLabel,
  transcriptRoleKind,
} from "../format";
import { cn } from "../styles";
import type { ConversationTranscript, TranscriptViewMessage } from "../types";
import { shouldCopyRawTranscript } from "./transcriptCopy";
import {
  messageRawText,
  type TranscriptViewMode,
} from "./transcriptRenderModel";
import {
  TranscriptHeadingMeta,
  TranscriptHeadingRow,
} from "./TranscriptHeadingRow";
import { RedactedMarker } from "./TranscriptRedacted";
import { SlackMark } from "./SlackMark";
import { TranscriptText } from "./TranscriptText";
import { TranscriptTurnContextView } from "./TranscriptTurnContextView";
import { showsSlackSourceIcon } from "./transcriptSource";

/** Render one primary chat message bubble and its attached turn context. */
export const TranscriptMessageView = memo(
  function TranscriptMessageView(props: {
    message: TranscriptViewMessage;
    conversation: ConversationTranscript;
    view: TranscriptViewMode;
  }) {
    const rawText = messageRawText(props.message);
    const role = props.message.role;

    return (
      <TranscriptMessageShell
        role={props.message.role}
        onCopy={(event) => {
          const selection = event.currentTarget.ownerDocument.getSelection();
          if (
            !shouldCopyRawTranscript(
              props.view,
              rawText,
              selection,
              event.currentTarget,
            )
          ) {
            return;
          }
          event.clipboardData.setData("text/plain", rawText);
          event.preventDefault();
        }}
      >
        <TranscriptMessageHeader
          meta={[formatMessageTimestamp(props.message.timestamp)]}
          message={props.message}
          conversation={props.conversation}
        />
        {props.view === "raw" ? (
          <HighlightedCode
            code={rawText}
            language={detectLanguage(rawText)}
          />
        ) : (
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
            {props.message.parts.map((part, index) =>
              part.type === "text" ? (
                <TranscriptText key={index} role={role} text={part.text ?? ""} />
              ) : null,
            )}
          </div>
        )}
        {props.view === "rich" &&
        props.message.role === "user" &&
        props.message.contexts?.length ? (
          <TranscriptTurnContextView contexts={props.message.contexts} />
        ) : null}
      </TranscriptMessageShell>
    );
  },
  (previous, next) =>
    previous.view === next.view &&
    previous.message === next.message &&
    previous.conversation.surface === next.conversation.surface &&
    previous.conversation.actorIdentity === next.conversation.actorIdentity,
);

/** Render a redacted primary chat message without exposing body content. */
export function RedactedMessageView(props: {
  message: TranscriptViewMessage;
  conversation: ConversationTranscript;
}) {
  const meta = [formatMessageTimestamp(props.message.timestamp)].filter(
    isString,
  );

  return (
    <TranscriptMessageShell role={props.message.role}>
      <TranscriptMessageHeader
        meta={meta}
        message={props.message}
        conversation={props.conversation}
      />
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 font-mono text-base leading-snug text-dashboard-text-muted">
        {props.message.parts.map((_part, index) => (
          <RedactedMetadataRow key={index} />
        ))}
      </div>
    </TranscriptMessageShell>
  );
}

function TranscriptMessageShell(props: {
  children: ReactNode;
  onCopy?: ClipboardEventHandler<HTMLElement>;
  role: string;
}) {
  return (
    <article
      className={transcriptMessageClass(props.role)}
      onCopy={props.onCopy}
    >
      {props.children}
    </article>
  );
}

function TranscriptMessageHeader(props: {
  meta?: Array<string | undefined>;
  message: TranscriptViewMessage;
  conversation: ConversationTranscript;
}) {
  const showSlack = showsSlackSourceIcon(props.message, props.conversation);
  const metaText = (props.meta ?? []).filter(isString).join(" · ");
  const roleLabel = transcriptMessageActorLabel(
    props.conversation,
    props.message,
  );

  return (
    <TranscriptHeadingRow
      left={
        <span className={transcriptRoleLabelClass(props.message.role)}>
          {roleLabel}
        </span>
      }
      leftClassName={transcriptRoleClass(props.message.role)}
      right={
        showSlack || metaText ? (
          <TranscriptHeadingMeta className="flex min-w-0 items-center gap-1.5 break-words text-2xs leading-snug text-dashboard-text-muted/80 md:leading-none">
            {showSlack ? (
              <span className="inline-flex shrink-0" title="Slack">
                <SlackMark className="size-3.5" />
              </span>
            ) : null}
            {showSlack && metaText ? <span aria-hidden="true">·</span> : null}
            {metaText}
          </TranscriptHeadingMeta>
        ) : undefined
      }
    />
  );
}

function RedactedMetadataRow(props: { meta?: string }) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-1 max-md:grid-cols-1">
      <RedactedMarker />
      {props.meta ? (
        <span className="min-w-0 break-words text-right text-dashboard-text-muted max-md:text-left">
          {props.meta}
        </span>
      ) : null}
    </div>
  );
}

function transcriptMessageClass(role: string): string {
  const kind = transcriptRoleKind(role);

  return cn(
    "grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 rounded-2xl px-3 py-2 md:gap-1.5 md:px-3.5 md:py-2.5",
    kind === "assistant" && "mr-6 bg-[#0f191c] text-dashboard-text md:mr-[18%]",
    kind === "user" && "ml-6 bg-[#1a1a1c] text-dashboard-text md:ml-[22%]",
    kind === "system" && "rounded-xl bg-[#17140d] text-dashboard-text",
    kind === "tool" && "rounded-none px-0 text-dashboard-text-muted",
    kind === "other" && "bg-dashboard-surface-hover text-dashboard-text",
  );
}

function transcriptRoleClass(role: string): string {
  const kind = transcriptRoleKind(role);

  return cn(
    "text-xs leading-snug",
    kind === "assistant" && "text-cyan-100/70",
    kind === "user" && "text-dashboard-text-muted",
    kind === "system" && "text-amber-200/80",
    kind === "tool" && "text-dashboard-text-muted",
    kind === "other" && "text-dashboard-text-muted",
  );
}

function transcriptRoleLabelClass(role: string): string {
  const kind = transcriptRoleKind(role);

  return cn(
    "inline-block max-w-full truncate font-display text-xs font-semibold leading-tight md:text-sm",
    kind === "assistant" && "text-cyan-100",
    kind === "user" && "text-dashboard-text",
    kind === "system" && "text-amber-200",
    kind === "tool" && "text-dashboard-text-muted",
    kind === "other" && "text-dashboard-text",
  );
}

function isString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}
