import { TranscriptAttachments } from "./TranscriptAttachment";

import { getDashboardAgentName } from "../agentName";
import { formatMessageTimestamp } from "../format";
import type {
  ConversationTranscript,
  TranscriptViewAttachmentsDeliveredPart,
} from "../types";
import { TranscriptMessageHeading } from "./TranscriptHeadingRow";
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
      <TranscriptMessageHeading>
        <span className="max-w-full truncate font-sans text-sm font-semibold leading-6 text-cyan-100">
          {getDashboardAgentName()}
        </span>
        {timestamp ? (
          <span className="text-xs leading-6 text-dashboard-text-muted">
            {timestamp}
          </span>
        ) : null}
      </TranscriptMessageHeading>
      <TranscriptAttachments
        attachments={props.part.attachments}
        conversationId={props.conversation.conversationId}
      />
    </TranscriptMessageShell>
  );
}
