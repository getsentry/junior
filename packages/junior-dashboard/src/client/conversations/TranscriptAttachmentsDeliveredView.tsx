import { TranscriptAttachments } from "./TranscriptAttachment";

import { getDashboardAgentName } from "../agentName";
import type {
  ConversationTranscript,
  TranscriptViewAttachmentsDeliveredPart,
} from "../types";
import { TranscriptMessageHeading } from "./TranscriptHeadingRow";
import { TranscriptMessageShell } from "./TranscriptMessageShell";
import { TranscriptTimestamp } from "./TranscriptTimestamp";

/** Render host-delivered conversation attachments as first-class transcript media. */
export function TranscriptAttachmentsDeliveredView(props: {
  conversation: ConversationTranscript;
  part: TranscriptViewAttachmentsDeliveredPart;
  timestamp?: number;
}) {
  return (
    <TranscriptMessageShell role="assistant" actor={getDashboardAgentName()}>
      <TranscriptMessageHeading>
        <span className="max-w-full truncate font-sans text-sm font-semibold leading-6 text-dashboard-accent-text">
          {getDashboardAgentName()}
        </span>
        {typeof props.timestamp === "number" ? (
          <span className="text-xs leading-6 text-dashboard-text-muted">
            <TranscriptTimestamp value={props.timestamp} />
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
