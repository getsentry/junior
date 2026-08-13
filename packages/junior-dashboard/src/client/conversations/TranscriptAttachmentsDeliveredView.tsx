import { Download, FileText, Image as ImageIcon } from "lucide-react";

import { formatMessageTimestamp } from "../format";
import type {
  ConversationTranscript,
  TranscriptViewAttachmentsDeliveredPart,
  TranscriptViewDeliveredAttachment,
} from "../types";
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

function formatAttachmentBytes(bytes: number | undefined): string | undefined {
  if (bytes === undefined) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentCard(props: {
  attachment: TranscriptViewDeliveredAttachment;
  conversationId: string;
}) {
  const search = useTranscriptSearch();
  const href = attachmentUrl(props.conversationId, props.attachment.id);
  const size = formatAttachmentBytes(props.attachment.bytes);
  const inline = mayDisplayInline(props.attachment.contentType);

  return (
    <div className="min-w-0 overflow-hidden rounded-md border border-white/10 bg-white/[0.03]">
      {inline && !search.active ? (
        <a
          className="block bg-black/20"
          href={href}
          rel="noreferrer"
          target="_blank"
        >
          <img
            alt={props.attachment.name}
            className="max-h-80 w-full object-contain"
            loading="lazy"
            src={href}
          />
        </a>
      ) : null}
      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2">
        <span
          aria-hidden="true"
          className="grid size-7 place-items-center rounded bg-black/25 text-dashboard-text-muted"
        >
          {inline ? <ImageIcon size={13} /> : <FileText size={13} />}
        </span>
        <div className="min-w-0">
          <div className="truncate font-mono text-xs text-dashboard-text">
            <HighlightText text={props.attachment.name} />
          </div>
          <div className="truncate font-mono text-2xs text-dashboard-text-muted">
            <HighlightText
              text={[props.attachment.contentType, size]
                .filter((value): value is string => value !== undefined)
                .join(" · ")}
            />
          </div>
        </div>
        <a
          className="inline-flex items-center gap-1 rounded border border-white/10 px-2 py-1 font-mono text-2xs text-dashboard-text-muted no-underline hover:border-white/25 hover:text-dashboard-text"
          download={props.attachment.name}
          href={href}
          rel="noreferrer"
        >
          <Download size={11} />
          download
        </a>
      </div>
    </div>
  );
}

/** Render host-delivered conversation attachments as first-class transcript media. */
export function TranscriptAttachmentsDeliveredView(props: {
  conversation: ConversationTranscript;
  part: TranscriptViewAttachmentsDeliveredPart;
  timestamp?: number;
}) {
  const timestamp = formatMessageTimestamp(props.timestamp);
  const count = props.part.attachments.length;
  const title = count === 1 ? "1 file delivered" : `${count} files delivered`;

  return (
    <div className="min-w-0 rounded-md bg-sky-300/[0.07] px-2.5 py-1.5 font-mono text-xs leading-tight">
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2 max-md:grid-cols-[minmax(0,1fr)]">
        <div className="font-display text-sm font-semibold text-sky-100">
          <HighlightText text={title} />
        </div>
        {timestamp ? (
          <span className="font-mono text-xs text-dashboard-text-muted max-md:hidden">
            {timestamp}
          </span>
        ) : null}
      </div>
      <div className="mt-2 grid gap-2">
        {props.part.attachments.map((attachment) => (
          <AttachmentCard
            attachment={attachment}
            conversationId={props.conversation.conversationId}
            key={attachment.id}
          />
        ))}
      </div>
    </div>
  );
}
