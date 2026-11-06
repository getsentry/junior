import {
  INPUT_IMAGE_TYPES,
  type InputImage,
  type MessageAttachment,
} from "@sentry/junior/api/schema";
import { FileText } from "lucide-react";
import { type ReactNode, createContext, useContext, useMemo } from "react";

import {
  ImageAttachment,
  type PreviewImage,
} from "../components/ImageAttachment";
import type { TranscriptViewMessage } from "../types";
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

/** Show the images of a send before the server stores them. */
export function TranscriptLocalImages(props: { images: InputImage[] }) {
  return (
    <div className="flex min-w-0 flex-wrap items-start gap-2">
      {props.images.map((image, index) => (
        <ImageAttachment
          filename={image.filename}
          imageClassName={TRANSCRIPT_IMAGE_CLASS}
          key={`${image.filename}:${index}`}
          src={inputImageSrc(image)}
          triggerClassName={TRANSCRIPT_IMAGE_TRIGGER_CLASS}
        />
      ))}
    </div>
  );
}

const TRANSCRIPT_IMAGE_CLASS =
  "max-h-48 w-auto max-w-full h-auto rounded-lg object-contain";
const TRANSCRIPT_IMAGE_TRIGGER_CLASS =
  "block min-w-0 max-w-full flex-none rounded-lg border border-dashboard-border bg-dashboard-fill-faint transition-colors hover:border-dashboard-border-interactive hover:bg-dashboard-fill-hover focus-visible:outline-2 focus-visible:outline-dashboard-focus";

/** Render one stored user or assistant attachment using the private read route. */
function TranscriptAttachment(props: {
  attachment: MessageAttachment;
  conversationId: string;
}) {
  const search = useTranscriptSearch();
  const groups = useContext(TranscriptImageGroupsContext);
  const href = conversationAttachmentUrl(
    props.conversationId,
    props.attachment.id,
  );
  const gallery = groups.find((group) =>
    group.some(
      (image) =>
        image.src === href && image.filename === props.attachment.filename,
    ),
  );
  const meta = attachmentMeta(props.attachment);

  if (isInlineImage(props.attachment) && !search.active) {
    return (
      <ImageAttachment
        context={meta}
        filename={props.attachment.filename}
        gallery={gallery}
        imageClassName={TRANSCRIPT_IMAGE_CLASS}
        loading="lazy"
        src={href}
        triggerClassName={TRANSCRIPT_IMAGE_TRIGGER_CLASS}
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
