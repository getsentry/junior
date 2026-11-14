import { INPUT_IMAGE_TYPES } from "@sentry/junior/api/schema";
import { FileText } from "lucide-react";
import { conversationAttachmentUrl } from "../conversations/TranscriptAttachment";
import { cn } from "../styles";
import type { Conversation } from "../types";

type Media = NonNullable<Conversation["media"]>[number];

function isImage(media: Media): boolean {
  return INPUT_IMAGE_TYPES.some((type) => type === media.contentType);
}

const TILE =
  "flex h-14 shrink-0 items-center overflow-hidden rounded-md border border-dashboard-border bg-dashboard-fill-faint transition-colors hover:border-dashboard-border-strong focus-visible:outline-2 focus-visible:outline-dashboard-focus";

/**
 * The newest files of a Conversation on a comfortable Inbox row: images as
 * thumbnails, other files by name. Each opens the stored file in a new tab.
 */
export function InboxMedia(props: { conversationId: string; media: Media[] }) {
  return (
    <div
      aria-label="Files"
      className="flex min-w-0 items-center gap-2 overflow-x-auto"
      role="group"
    >
      {props.media.map((media) => {
        const href = conversationAttachmentUrl(props.conversationId, media.id);
        return isImage(media) ? (
          <a
            className={cn(TILE, "aspect-[4/3]")}
            href={href}
            key={media.id}
            rel="noreferrer"
            target="_blank"
          >
            <img
              alt={media.filename}
              className="size-full object-cover"
              decoding="async"
              loading="lazy"
              src={href}
            />
          </a>
        ) : (
          <a
            className={cn(
              TILE,
              "w-40 gap-2 px-2.5 font-sans text-xs text-dashboard-text-muted no-underline",
            )}
            href={href}
            key={media.id}
            rel="noreferrer"
            target="_blank"
          >
            <FileText aria-hidden="true" className="size-4 shrink-0" />
            <span className="truncate">{media.filename}</span>
          </a>
        );
      })}
    </div>
  );
}
