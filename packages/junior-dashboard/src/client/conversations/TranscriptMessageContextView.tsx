import { ChevronRight } from "lucide-react";

import { formatMessageTimestamp, transcriptMessageActorLabel } from "../format";
import type { ConversationTranscript, TranscriptViewMessage } from "../types";
import {
  TranscriptHeadingMeta,
  TranscriptHeadingRow,
} from "./TranscriptHeadingRow";
import { HighlightText } from "./transcriptSearch";
import { messageRawText } from "./transcriptRenderModel";
import { RedactedMarker } from "./TranscriptRedacted";
import { TranscriptTurnContextView } from "./TranscriptTurnContextView";

/** Render ambient conversation context that is not a primary chat bubble. */
export function TranscriptMessageContextView(props: {
  conversation: ConversationTranscript;
  message: TranscriptViewMessage;
  redacted?: boolean;
}) {
  const actor = transcriptMessageActorLabel(props.conversation, props.message);
  const timestamp = formatMessageTimestamp(props.message.timestamp);
  const text = messageRawText(props.message);

  const content = props.redacted ? (
    <RedactedMarker />
  ) : (
    <HighlightText text={text} />
  );

  return (
    <>
      <details
        className="group/message-context min-w-0 rounded-lg bg-dashboard-fill-soft px-3 py-2.5 md:hidden"
        data-transcript-message-context
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 font-display text-xs font-semibold text-dashboard-text-muted [&::-webkit-details-marker]:hidden">
          <span className="min-w-0 truncate">Context from {actor}</span>
          <ChevronRight
            aria-hidden="true"
            className="shrink-0 transition-transform group-open/message-context:rotate-90"
            size={14}
          />
        </summary>
        <div className="mt-2 whitespace-pre-wrap pt-2 text-sm leading-relaxed text-dashboard-text/75">
          {content}
        </div>
        {!props.redacted && props.message.contexts?.length ? (
          <div className="mt-2">
            <TranscriptTurnContextView contexts={props.message.contexts} />
          </div>
        ) : null}
      </details>
      <article
        className="hidden min-w-0 rounded-lg bg-dashboard-fill-soft px-3 py-2.5 md:block"
        data-transcript-message-context
      >
        <TranscriptHeadingRow
          left={
            <span className="font-display text-xs font-semibold text-dashboard-text-muted">
              Context from {actor}
            </span>
          }
          leftClassName="min-w-0"
          right={
            timestamp ? (
              <TranscriptHeadingMeta className="font-mono text-2xs text-dashboard-text-muted/70">
                {timestamp}
              </TranscriptHeadingMeta>
            ) : undefined
          }
        />
        <div className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-dashboard-text/75">
          {content}
        </div>
        {!props.redacted && props.message.contexts?.length ? (
          <div className="mt-2">
            <TranscriptTurnContextView contexts={props.message.contexts} />
          </div>
        ) : null}
      </article>
    </>
  );
}
