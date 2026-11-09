import {
  INLINE_VIDEO_TYPES,
  INPUT_IMAGE_TYPES,
  type InputImage,
  type MessageAttachment,
} from "@sentry/junior/api/schema";
import { Download, FileText } from "lucide-react";
import {
  type ReactNode,
  createContext,
  useContext,
  useMemo,
  useState,
} from "react";

import {
  ImageAttachment,
  type PreviewImage,
} from "../components/ImageAttachment";
import type { TranscriptViewMessage } from "../types";
import { TextAttachmentPreview } from "./TextAttachmentPreview";
import { textPreviewLanguage } from "./textPreview";
import { HighlightText, useTranscriptSearch } from "./transcriptSearch";

/** Build a data URL that previews an image before the server stores it. */
export function inputImageSrc(image: InputImage): string {
  return `data:${image.contentType};base64,${image.data}`;
}

/** Build the private read route for one stored conversation attachment. */
export function conversationAttachmentUrl(
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

function isInlineImage(attachment: MessageAttachment): boolean {
  return INPUT_IMAGE_TYPES.some((type) => type === attachment.contentType);
}

function isInlineVideo(attachment: MessageAttachment): boolean {
  return INLINE_VIDEO_TYPES.some((type) => type === attachment.contentType);
}

function attachmentMeta(attachment: MessageAttachment): string {
  return [attachment.contentType, formatAttachmentBytes(attachment.bytes)].join(
    " · ",
  );
}

function previewImages(
  conversationId: string,
  attachments: readonly MessageAttachment[],
): PreviewImage[] {
  return attachments.filter(isInlineImage).map((attachment) => ({
    context: attachmentMeta(attachment),
    filename: attachment.filename,
    src: conversationAttachmentUrl(conversationId, attachment.id),
  }));
}

/**
 * Group stored transcript images so one preview pages through one group. A
 * user message keeps its own images. The images Junior sends after it, across
 * any number of messages, form that message's response.
 */
export function transcriptImageGroups(
  conversationId: string,
  messages: readonly TranscriptViewMessage[],
): PreviewImage[][] {
  const groups: PreviewImage[][] = [];
  let response: PreviewImage[] | undefined;
  for (const message of messages) {
    if (message.role === "user") {
      const sent = previewImages(conversationId, message.attachments ?? []);
      if (sent.length > 0) groups.push(sent);
      // A context message can arrive during a response. It does not start one.
      if (!message.context) response = undefined;
      continue;
    }
    const delivered = previewImages(conversationId, [
      ...(message.attachments ?? []),
      ...message.parts.flatMap((part) =>
        part.type === "attachments_delivered" ? part.attachments : [],
      ),
    ]);
    if (delivered.length === 0) continue;
    if (!response) {
      response = [];
      groups.push(response);
    }
    response.push(...delivered);
  }
  return groups;
}

const TranscriptImageGroupsContext = createContext<
  readonly (readonly PreviewImage[])[]
>([]);

/** Share the transcript image groups with each image preview below it. */
export function TranscriptImagesProvider(props: {
  children: ReactNode;
  conversationId: string;
  messages: readonly TranscriptViewMessage[];
}) {
  const groups = useMemo(
    () => transcriptImageGroups(props.conversationId, props.messages),
    [props.conversationId, props.messages],
  );
  return (
    <TranscriptImageGroupsContext.Provider value={groups}>
      {props.children}
    </TranscriptImageGroupsContext.Provider>
  );
}

// Every media tile shares one column width and one 4:3 frame, so images and
// videos of any size line up. Files use a row of the same width below them.
const ATTACHMENT_COLUMNS_CLASS = "sm:grid-cols-[repeat(auto-fill,15rem)]";
const MEDIA_GRID_CLASS = `grid min-w-0 grid-cols-2 gap-2 ${ATTACHMENT_COLUMNS_CLASS}`;
// A file row needs the full phone width to show its name and size.
const FILE_GRID_CLASS = `grid min-w-0 grid-cols-1 gap-2 ${ATTACHMENT_COLUMNS_CLASS}`;
const MEDIA_FRAME_CLASS =
  "block aspect-[4/3] w-full overflow-hidden rounded-lg border border-dashboard-border bg-dashboard-fill-faint";
const TRANSCRIPT_IMAGE_CLASS = "size-full object-cover";
const TRANSCRIPT_IMAGE_TRIGGER_CLASS = `${MEDIA_FRAME_CLASS} transition-colors hover:border-dashboard-border-interactive focus-visible:outline-2 focus-visible:outline-dashboard-focus`;

/** Show message media in equal tiles, then files in equal rows below them. */
export function TranscriptAttachments(props: {
  attachments: MessageAttachment[];
  conversationId: string;
}) {
  const search = useTranscriptSearch();
  if (props.attachments.length === 0) return null;
  // Search highlights filenames, so every attachment shows as a file row.
  const isMedia = (attachment: MessageAttachment) =>
    !search.active && (isInlineImage(attachment) || isInlineVideo(attachment));
  const entries = props.attachments.map((attachment, index) => ({
    attachment,
    key: `${attachment.id}:${index}`,
  }));
  const media = entries.filter((entry) => isMedia(entry.attachment));
  const files = entries.filter((entry) => !isMedia(entry.attachment));
  return (
    <div className="grid min-w-0 gap-2">
      {media.length > 0 ? (
        <div className={MEDIA_GRID_CLASS}>
          {media.map((entry) => (
            <TranscriptMediaTile
              attachment={entry.attachment}
              conversationId={props.conversationId}
              key={entry.key}
            />
          ))}
        </div>
      ) : null}
      {files.length > 0 ? (
        <div className={FILE_GRID_CLASS}>
          {files.map((entry) => (
            <TranscriptFileRow
              attachment={entry.attachment}
              conversationId={props.conversationId}
              key={entry.key}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Show the images of a send before the server stores them. */
export function TranscriptLocalImages(props: { images: InputImage[] }) {
  return (
    <div className={MEDIA_GRID_CLASS}>
      {props.images.map((image, index) => (
        <figure
          className="grid min-w-0 gap-1"
          key={`${image.filename}:${index}`}
        >
          <ImageAttachment
            filename={image.filename}
            imageClassName={TRANSCRIPT_IMAGE_CLASS}
            src={inputImageSrc(image)}
            triggerClassName={TRANSCRIPT_IMAGE_TRIGGER_CLASS}
          />
          <MediaCaption filename={image.filename} />
        </figure>
      ))}
    </div>
  );
}

function MediaCaption(props: {
  bytes?: number;
  download?: { filename: string; href: string };
  filename: string;
}) {
  return (
    <figcaption className="flex h-6 min-w-0 items-center gap-1.5 px-0.5 font-mono text-xs">
      <span className="min-w-0 flex-1 truncate text-dashboard-text">
        {props.filename}
      </span>
      {typeof props.bytes === "number" ? (
        <span className="flex-none text-dashboard-text-muted">
          {formatAttachmentBytes(props.bytes)}
        </span>
      ) : null}
      {props.download ? (
        <a
          aria-label={`Download ${props.download.filename}`}
          className="grid size-6 flex-none place-items-center rounded text-dashboard-text-muted hover:bg-dashboard-fill-hover hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-dashboard-focus"
          download={props.download.filename}
          href={props.download.href}
          rel="noreferrer"
          target="_blank"
        >
          <Download size={13} />
        </a>
      ) : null}
    </figcaption>
  );
}

/** Render one stored image or video in a fixed media frame. */
function TranscriptMediaTile(props: {
  attachment: MessageAttachment;
  conversationId: string;
}) {
  const groups = useContext(TranscriptImageGroupsContext);
  const href = conversationAttachmentUrl(
    props.conversationId,
    props.attachment.id,
  );
  const { filename, bytes } = props.attachment;

  if (isInlineImage(props.attachment)) {
    const gallery = groups.find((group) =>
      group.some((image) => image.src === href && image.filename === filename),
    );
    return (
      <figure className="grid min-w-0 gap-1">
        <ImageAttachment
          context={attachmentMeta(props.attachment)}
          filename={filename}
          gallery={gallery}
          imageClassName={TRANSCRIPT_IMAGE_CLASS}
          loading="lazy"
          src={href}
          triggerClassName={TRANSCRIPT_IMAGE_TRIGGER_CLASS}
        />
        <MediaCaption bytes={bytes} filename={filename} />
      </figure>
    );
  }

  // A small frame crowds the native controls on a phone, so a video takes
  // the full row there.
  return (
    <figure className="col-span-2 grid min-w-0 gap-1 sm:col-span-1">
      <video
        aria-label={filename}
        className={`${MEDIA_FRAME_CLASS} bg-dashboard-ink object-contain`}
        controls
        playsInline
        preload="metadata"
        src={href}
      />
      <MediaCaption
        bytes={bytes}
        download={{ filename, href }}
        filename={filename}
      />
    </figure>
  );
}

// Every file row shares this look, as a preview button or a download link.
const FILE_ROW_CLASS =
  "grid w-full min-w-0 cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded-lg border border-dashboard-border bg-dashboard-fill-faint px-3 py-2 text-left font-sans no-underline transition-colors hover:border-dashboard-border-interactive hover:bg-dashboard-fill-hover focus-visible:outline-2 focus-visible:outline-dashboard-focus";

/** Render one stored file as a row that previews text or downloads the file. */
function TranscriptFileRow(props: {
  attachment: MessageAttachment;
  conversationId: string;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const href = conversationAttachmentUrl(
    props.conversationId,
    props.attachment.id,
  );
  const meta = attachmentMeta(props.attachment);
  const language = textPreviewLanguage(props.attachment);
  const label = (
    <>
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
        <div className="truncate font-mono text-xs text-dashboard-text-muted">
          <HighlightText text={meta} />
        </div>
      </div>
    </>
  );

  if (!language) {
    // `target="_blank"`: an installed iOS home screen app has no back button.
    // Opening a file in the same window traps the user in the iOS file preview.
    return (
      <a
        className={FILE_ROW_CLASS}
        download={props.attachment.filename}
        href={href}
        rel="noreferrer"
        target="_blank"
      >
        {label}
      </a>
    );
  }

  return (
    <>
      <button
        aria-haspopup="dialog"
        className={FILE_ROW_CLASS}
        onClick={() => setPreviewOpen(true)}
        type="button"
      >
        {label}
      </button>
      {previewOpen ? (
        <TextAttachmentPreview
          attachment={props.attachment}
          href={href}
          language={language}
          meta={meta}
          onClose={() => setPreviewOpen(false)}
        />
      ) : null}
    </>
  );
}
