import {
  INPUT_IMAGE_TYPES,
  type MessageAttachment,
} from "@sentry/junior/api/schema";
import { FileText } from "lucide-react";
import { ImageAttachment } from "../components/ImageAttachment";
import { HighlightText, useTranscriptSearch } from "./transcriptSearch";

function attachmentUrl(conversationId: string, attachmentId: string): string {
  return `/api/conversations/${encodeURIComponent(conversationId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

function formatAttachmentBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Keep message attachments at their own size and wrap them when the row is full. */
export function TranscriptAttachments(props: {
  attachments: MessageAttachment[];
  conversationId: string;
}) {
  if (props.attachments.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-start gap-2">
      {props.attachments.map((attachment, index) => (
        <TranscriptAttachment
          attachment={attachment}
          conversationId={props.conversationId}
          key={`${attachment.id}:${index}`}
        />
      ))}
    </div>
  );
}

/** Render one stored user or assistant attachment using the private read route. */
function TranscriptAttachment(props: {
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
        imageClassName="max-h-48 w-auto max-w-full h-auto rounded-lg object-contain"
        loading="lazy"
        src={href}
        triggerClassName="block min-w-0 max-w-full flex-none rounded-lg border border-dashboard-border bg-dashboard-fill-faint transition-colors hover:border-dashboard-border-interactive hover:bg-dashboard-fill-hover focus-visible:outline-2 focus-visible:outline-dashboard-focus"
      />
    );
  }

  return (
    <a
      className="grid min-w-0 max-w-full flex-none grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded-lg border border-dashboard-border bg-dashboard-fill-faint px-3 py-2 no-underline transition-colors hover:border-dashboard-border-interactive hover:bg-dashboard-fill-hover focus-visible:outline-2 focus-visible:outline-dashboard-focus"
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
