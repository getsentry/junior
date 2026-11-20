import { FileText } from "lucide-react";
import { conversationAttachmentUrl } from "../conversations/TranscriptAttachment";
import type { ConversationMedia } from "./useConversationImages";
import { fadeOverflowClass, fadeWhenOverflowing } from "../textFade";

/**
 * The newest files of a Conversation that are not images, by name, on a
 * comfortable Inbox row. Each opens the stored file in a new tab. Images
 * show in the row's image strip.
 */
export function InboxFiles(props: {
  conversationId: string;
  files: ConversationMedia[];
}) {
  return (
    <div
      aria-label="Files"
      className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1"
      role="group"
    >
      {props.files.map((file) => (
        <a
          className="flex min-w-0 max-w-60 items-center gap-1.5 rounded-sm font-sans text-xs text-dashboard-text-muted no-underline hover:text-dashboard-text hover:underline focus-visible:outline-2 focus-visible:outline-dashboard-focus"
          href={conversationAttachmentUrl(props.conversationId, file.id)}
          key={`${file.id}\n${file.filename}`}
          rel="noreferrer"
          target="_blank"
        >
          <FileText aria-hidden="true" className="size-3.5 shrink-0" />
          <span className={fadeOverflowClass} ref={fadeWhenOverflowing}>
            {file.filename}
          </span>
        </a>
      ))}
    </div>
  );
}
