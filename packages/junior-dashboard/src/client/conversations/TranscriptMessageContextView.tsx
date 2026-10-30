import { ChevronRight } from "lucide-react";
import { useState } from "react";

import { Collapsible, CollapsibleContent } from "../components/ui/collapsible";
import { dashboardDisclosureChevronClass } from "../styles";
import { formatMessageTimestamp, transcriptMessageActorLabel } from "../format";
import type { ConversationTranscript, TranscriptViewMessage } from "../types";
import {
  TranscriptHeadingMeta,
  TranscriptHeadingRow,
} from "./TranscriptHeadingRow";
import { HighlightText, useTranscriptSearch } from "./transcriptSearch";
import { messageRawText } from "./transcriptRenderModel";
import { RedactedMarker } from "./TranscriptRedacted";
import { TranscriptTurnContextView } from "./TranscriptTurnContextView";
import { TranscriptSummaryTrigger } from "./TranscriptSummary";

/** Render ambient conversation context that is not a primary chat bubble. */
export function TranscriptMessageContextView(props: {
  conversation: ConversationTranscript;
  message: TranscriptViewMessage;
  redacted?: boolean;
}) {
  const { active: searchActive } = useTranscriptSearch();
  const [open, setOpen] = useState(false);
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
      <Collapsible
        className="min-w-0 rounded-lg border border-dashboard-border-subtle bg-dashboard-surface-panel px-3 py-2.5 md:hidden"
        data-transcript-message-context
        // Search holds the text open, so the heading button is off until
        // search ends.
        disabled={searchActive}
        onOpenChange={setOpen}
        open={searchActive || open}
      >
        <TranscriptSummaryTrigger
          flush
          className="group flex items-center justify-between gap-2 font-sans text-xs font-medium text-dashboard-text-muted"
        >
          <span className="min-w-0 truncate">Context from {actor}</span>
          <ChevronRight
            aria-hidden="true"
            className={dashboardDisclosureChevronClass}
          />
        </TranscriptSummaryTrigger>
        <CollapsibleContent hiddenUntilFound>
          <div className="mt-2 whitespace-pre-wrap pt-2 text-sm leading-relaxed text-dashboard-text-subtle">
            {content}
          </div>
          {!props.redacted && props.message.contexts?.length ? (
            <div className="mt-2">
              <TranscriptTurnContextView
                contexts={props.message.contexts}
                messageId={props.message.messageId}
              />
            </div>
          ) : null}
        </CollapsibleContent>
      </Collapsible>
      <article
        className="hidden min-w-0 rounded-lg border border-dashboard-border-subtle bg-dashboard-surface-panel px-3 py-2.5 md:block"
        data-transcript-message-context
      >
        <TranscriptHeadingRow
          left={
            <span className="font-sans text-xs font-medium text-dashboard-text-muted">
              Context from {actor}
            </span>
          }
          leftClassName="min-w-0"
          right={
            timestamp ? (
              <TranscriptHeadingMeta className="text-xs tabular-nums text-dashboard-text-muted">
                {timestamp}
              </TranscriptHeadingMeta>
            ) : undefined
          }
        />
        <div className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-dashboard-text-subtle">
          {content}
        </div>
        {!props.redacted && props.message.contexts?.length ? (
          <div className="mt-2">
            <TranscriptTurnContextView
              contexts={props.message.contexts}
              messageId={props.message.messageId}
            />
          </div>
        ) : null}
      </article>
    </>
  );
}
