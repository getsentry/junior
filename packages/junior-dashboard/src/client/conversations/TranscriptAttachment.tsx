import { INPUT_IMAGE_TYPES } from "@sentry/junior/api/schema";
import { FileText } from "lucide-react";
import { ImageAttachment } from "../components/ImageAttachment";
import type { MessageAttachment } from "@sentry/junior/api/schema";
import { HighlightText, useTranscriptSearch } from "./transcriptSearch";

function attachmentUrl(conversationId: string, attachmentId: string): string {
  return `/api/conversations/${encodeURIComponent(conversationId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

function formatAttachmentBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Render one stored user or assistant attachment using the private read route. */
export function TranscriptAttachment(props: {
  attachment: MessageAttachment;
  conversationId: string;
}) {
  const search = useTranscriptSearch();
  const href = attachmentUrl(props.conversationId, props.attachment.id);
  const size = formatAttachmentBytes(props.attachment.bytes);
  const inline = INPUT_IMAGE_TYPES.some(
    (type) => type === props.attachment.contentType,
  );
  const meta = [props.attachment.contentType, size].join(" · ");

  if (inline && !search.active) {
    return (
      <ImageAttachment
        context={meta}
        filename={props.attachment.filename}
        imageClassName="max-h-48 w-auto max-w-full h-auto rounded-md object-contain"
        loading="lazy"
        src={href}
        triggerClassName="block min-w-0 max-w-full"
      />
    );
  }

  return (
    <a
      className="grid min-w-0 w-full max-w-full grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded-md px-1.5 py-1 -mx-1.5 no-underline transition-colors hover:bg-white/[0.04]"
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
