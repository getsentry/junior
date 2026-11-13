import { FileText, X } from "lucide-react";
import {
  MAX_INPUT_ATTACHMENT_BYTES,
  MAX_INPUT_ATTACHMENTS,
  type MessageAttachment,
} from "@sentry/junior/api/schema";
import { Button } from "../components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import {
  conversationAttachmentUrl,
  formatAttachmentBytes,
  isImageFile,
  useFileUrl,
} from "./TranscriptAttachment";

/** What a reader can attach to one message. */
export const COMPOSER_FILE_LIMIT = `up to ${MAX_INPUT_ATTACHMENTS} files, ${MAX_INPUT_ATTACHMENT_BYTES / 1024 / 1024} MB each`;

/** True when these files fit the message file count and size limits. */
export function composerFilesFit(files: readonly File[]): boolean {
  return (
    files.length <= MAX_INPUT_ATTACHMENTS &&
    files.every(
      (file) => file.size > 0 && file.size <= MAX_INPUT_ATTACHMENT_BYTES,
    )
  );
}

/** Read stored attachments back into composer files for an edit. */
export async function readStoredComposerFiles(
  conversationId: string,
  attachments: readonly MessageAttachment[] | undefined,
): Promise<File[]> {
  return await Promise.all(
    (attachments ?? []).map(async (attachment) => {
      const response = await fetch(
        conversationAttachmentUrl(conversationId, attachment.id),
      );
      if (!response.ok) throw new Error("Could not read the queued file.");
      return new File([await response.blob()], attachment.filename, {
        type: attachment.contentType,
      });
    }),
  );
}

/** Show removable files before sending. Bytes stay in memory until submit. */
export function ComposerFiles(props: {
  files: File[];
  disabled?: boolean;
  onRemove(index: number): void;
}) {
  return (
    <div className="col-span-full flex min-w-0 flex-wrap gap-2 px-3 pt-3">
      {props.files.map((file, index) => (
        <div
          className="relative min-w-0 rounded-lg border border-dashboard-border p-1"
          key={index}
        >
          {isImageFile(file) ? (
            <ComposerImagePreview file={file} />
          ) : (
            <div className="grid h-20 w-40 grid-rows-[auto_1fr_auto] gap-1 rounded-md px-2 py-1.5 font-mono text-xs">
              <FileText
                aria-hidden="true"
                className="text-dashboard-text-muted"
                size={14}
              />
              <span className="line-clamp-2 min-w-0 break-all pr-5 text-dashboard-text">
                {file.name}
              </span>
              <span className="text-dashboard-text-muted">
                {formatAttachmentBytes(file.size)}
              </span>
            </div>
          )}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  aria-label={`Remove ${file.name}`}
                  className="absolute right-0 top-0 size-7 rounded-full border border-dashboard-border bg-dashboard-surface-raised text-dashboard-text data-disabled:hover:bg-dashboard-surface-raised data-disabled:hover:text-dashboard-text"
                  disabled={props.disabled}
                  focusableWhenDisabled
                  onClick={() => props.onRemove(index)}
                  size="icon"
                  type="button"
                >
                  <X aria-hidden="true" size={14} />
                </Button>
              }
            />
            <TooltipContent size="compact">Remove file</TooltipContent>
          </Tooltip>
        </div>
      ))}
    </div>
  );
}

function ComposerImagePreview(props: { file: File }) {
  const src = useFileUrl(props.file);
  return src ? (
    <img
      alt={props.file.name}
      className="h-20 w-24 rounded-md object-contain"
      src={src}
    />
  ) : (
    <div className="h-20 w-24" />
  );
}
