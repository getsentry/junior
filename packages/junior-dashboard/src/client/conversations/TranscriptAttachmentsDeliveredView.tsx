import { TranscriptAttachments } from "./TranscriptAttachment";

import { getDashboardAgentName } from "../agentName";
import { formatMessageTimestamp } from "../format";
import type {
  ConversationTranscript,
  TranscriptViewAttachmentsDeliveredPart,
} from "../types";
import {
  TranscriptHeadingMeta,
  TranscriptHeadingRow,
} from "./TranscriptHeadingRow";
import { TranscriptMessageShell } from "./TranscriptMessageShell";

/** Render host-delivered conversation attachments as first-class transcript media. */
export function TranscriptAttachmentsDeliveredView(props: {
  conversation: ConversationTranscript;
  part: TranscriptViewAttachmentsDeliveredPart;
  timestamp?: number;
}) {
  const timestamp = formatMessageTimestamp(props.timestamp);

  return (
    <TranscriptMessageShell role="assistant" actor={getDashboardAgentName()}>
      <TranscriptHeadingRow
        left={
          <>
            <span className="inline-block max-w-full truncate font-sans text-sm font-semibold leading-tight text-cyan-100">
              {getDashboardAgentName()}
            </span>
            {timestamp ? (
              <TranscriptHeadingMeta className="shrink-0 whitespace-nowrap text-xs leading-snug text-dashboard-text-muted md:leading-none">
                {timestamp}
              </TranscriptHeadingMeta>
            ) : null}
          </>
        }
        leftClassName="flex-wrap gap-y-1 text-xs leading-snug text-cyan-100/70"
      />
      <TranscriptAttachments
        attachments={props.part.attachments}
        conversationId={props.conversation.conversationId}
      />
    </TranscriptMessageShell>
  );
}
