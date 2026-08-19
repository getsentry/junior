import { FileText } from "lucide-react";

import { getDashboardAgentName } from "../agentName";
import { ImageAttachment } from "../components/ImageAttachment";
import { formatMessageTimestamp } from "../format";
import type {
  ConversationTranscript,
  TranscriptViewAttachmentsDeliveredPart,
  TranscriptViewDeliveredAttachment,
} from "../types";
import {
  TranscriptHeadingMeta,
  TranscriptHeadingRow,
} from "./TranscriptHeadingRow";
import { transcriptMessageClass } from "./TranscriptMessageView";
import { HighlightText, useTranscriptSearch } from "./transcriptSearch";

function mayDisplayInline(contentType: string): boolean {
  return (
    contentType === "image/gif" ||
    contentType === "image/jpeg" ||
    contentType === "image/png" ||
    contentType === "image/webp"
  );
}

function attachmentUrl(
  conversationId: string,
  attachmentId: string,
): string {
  return `/api/conversations/${encodeURIComponent(conversationId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

function formatAttachmentBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentItem(props: {
  attachment: TranscriptViewDeliveredAttachment;
  conversationId: string;
}) {
  const search = useTranscriptSearch();
  const href = attachmentUrl(props.conversationId, props.attachment.id);
  const size = formatAttachmentBytes(props.attachment.bytes);
  const inline = mayDisplayInline(props.attachment.contentType);
  const meta = [props.attachment.contentType, size].join(" · ");

  if (inline && !search.active) {
    return (
      <ImageAttachment
        context={meta}
        filename={props.attachment.filename}
        imageClassName="max-h-48 max-w-sm h-auto w-auto rounded-md object-contain"
        loading="lazy"
        src={href}
        triggerClassName="inline-block max-w-full align-top"
      />
    );
  }

  return (
    <a
      className="grid min-w-0 max-w-sm grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded-md px-1.5 py-1 -mx-1.5 no-underline transition-colors hover:bg-white/[0.04]"
      download={props.attachment.filename}
      href={href}
      rel="noreferrer"
    >
      <span
        aria-hidden="true"
        className="grid size-6 place-items-center text-dashboard-text-muted"
      >
        <FileText size={13} />
      </span>
      <div className="min-w-0">
        <div className="truncate font-mono text-xs text-dashboard-text">
          <HighlightText text={props.attachment.filename} />
        </div>
        <div className="truncate font-mono text-2xs text-dashboard-text-muted">
          <HighlightText text={meta} />
        </div>
      </div>
    </a>
  );
}

/** Render host-delivered conversation attachments as first-class transcript media. */
export function TranscriptAttachmentsDeliveredView(props: {
  conversation: ConversationTranscript;
  part: TranscriptViewAttachmentsDeliveredPart;
  timestamp?: number;
}) {
  const timestamp = formatMessageTimestamp(props.timestamp);

  return (
    <article className={transcriptMessageClass("assistant")}>
      <TranscriptHeadingRow
        left={
          <span className="inline-block max-w-full truncate font-display text-xs font-semibold leading-tight text-cyan-100 md:text-sm">
            {getDashboardAgentName()}
          </span>
        }
        leftClassName="text-xs leading-snug text-cyan-100/70"
        right={
          timestamp ? (
            <TranscriptHeadingMeta className="text-2xs leading-snug text-dashboard-text-muted/80 md:leading-none">
              {timestamp}
            </TranscriptHeadingMeta>
          ) : undefined
        }
      />
      <div className="grid max-w-sm gap-2">
        {props.part.attachments.map((attachment) => (
          <AttachmentItem
            attachment={attachment}
            conversationId={props.conversation.conversationId}
            key={attachment.id}
          />
        ))}
      </div>
    </article>
  );
}
