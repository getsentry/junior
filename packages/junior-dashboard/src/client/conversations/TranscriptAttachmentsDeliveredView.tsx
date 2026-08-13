import { FileText, Image as ImageIcon } from "lucide-react";

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

function AttachmentItem(props: {
  attachment: TranscriptViewDeliveredAttachment;
  conversationId: string;
}) {
  const search = useTranscriptSearch();
  const href = attachmentUrl(props.conversationId, props.attachment.id);
  const size = formatAttachmentBytes(props.attachment.bytes);
  const inline = mayDisplayInline(props.attachment.contentType);
  const meta = [props.attachment.contentType, size]
    .filter((value): value is string => value !== undefined)
    .join(" · ");

  return (
    <div className="min-w-0">
      {inline && !search.active ? (
        <a
          className="mb-1.5 inline-block max-w-full overflow-hidden rounded-md bg-black/20"
          href={href}
          rel="noreferrer"
          target="_blank"
        >
          <img
            alt={props.attachment.name}
            className="max-h-48 max-w-sm h-auto w-auto object-contain"
            loading="lazy"
            src={href}
          />
        </a>
      ) : null}
      <a
        className="group/attachment grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded-md px-1.5 py-1 -mx-1.5 no-underline transition-colors hover:bg-white/[0.04]"
        download={props.attachment.name}
        href={href}
        rel="noreferrer"
      >
        <span
          aria-hidden="true"
          className="grid size-6 place-items-center text-dashboard-text-muted"
        >
          {inline ? <ImageIcon size={13} /> : <FileText size={13} />}
        </span>
        <div className="min-w-0">
          <div className="truncate font-mono text-xs text-dashboard-text group-hover/attachment:text-white">
            <HighlightText text={props.attachment.name} />
          </div>
          {meta ? (
            <div className="truncate font-mono text-2xs text-dashboard-text-muted">
              <HighlightText text={meta} />
            </div>
          ) : null}
        </div>
      </a>
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
    <article className="min-w-0 rounded-lg bg-white/[0.025] px-3 py-2.5">
      <TranscriptHeadingRow
        left={
          <span className="font-display text-xs font-semibold text-dashboard-text-muted">
            <HighlightText text={title} />
          </span>
        }
        leftClassName="min-w-0"
        right={
          timestamp ? (
            <TranscriptHeadingMeta className="font-mono text-2xs text-dashboard-text-muted/70 max-md:hidden">
              {timestamp}
            </TranscriptHeadingMeta>
          ) : undefined
        }
      />
      <div className="mt-2 grid gap-2">
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
