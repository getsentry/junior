import type { PiMessage } from "@/chat/pi/messages";

const MAX_INLINE_ATTACHMENT_BASE64_CHARS = 120_000;
const MAX_ROUTER_ATTACHMENT_PREVIEW_CHARS = 2_000;

export interface ReplyRequestAttachment {
  data?: Buffer;
  mediaType: string;
  filename?: string;
  promptText?: string;
}

export interface ReplySteeringMessageInput {
  omittedImageAttachmentCount?: number;
  text: string;
  timestampMs?: number;
  userAttachments?: ReplyRequestAttachment[];
}

export type UserTurnContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** Redact image data from prompt content parts for observability. */
export function toObservablePromptPart(
  part:
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string },
): Record<string, unknown> {
  if (part.type === "text") {
    return {
      type: "text",
      text: part.text,
    };
  }

  return {
    type: "image",
    mimeType: part.mimeType,
    data: `[omitted:${part.data.length}]`,
  };
}

function isStructuredThreadContext(context: string): boolean {
  return /^<thread-(compactions|transcript)>/.test(context);
}

function renderThreadContextForPrompt(context: string): string {
  if (isStructuredThreadContext(context)) {
    return context;
  }
  return ["<thread-background>", context, "</thread-background>"].join("\n");
}

/**
 * Put prior thread text before the current instruction when no Pi history
 * exists. Structured thread XML is already a top-level prompt block.
 */
export function buildUserTurnText(
  userInput: string,
  conversationContext?: string,
): string {
  const trimmedContext = conversationContext?.trim();

  if (!trimmedContext) {
    return userInput;
  }

  return [
    renderThreadContextForPrompt(trimmedContext),
    "",
    "<current-instruction>",
    userInput,
    "</current-instruction>",
  ].join("\n");
}

/** Encode a non-image attachment as base64 XML for the prompt. */
export function encodeNonImageAttachmentForPrompt(attachment: {
  data: Buffer;
  mediaType: string;
  filename?: string;
}): string {
  const base64 = attachment.data.toString("base64");
  const wasTruncated = base64.length > MAX_INLINE_ATTACHMENT_BASE64_CHARS;
  const encodedPayload = wasTruncated
    ? `${base64.slice(0, MAX_INLINE_ATTACHMENT_BASE64_CHARS)}...`
    : base64;

  return [
    "<attachment>",
    `filename: ${attachment.filename ?? "unnamed"}`,
    `media_type: ${attachment.mediaType}`,
    "encoding: base64",
    `truncated: ${wasTruncated ? "true" : "false"}`,
    "<data_base64>",
    encodedPayload,
    "</data_base64>",
    "</attachment>",
  ].join("\n");
}

function buildOmittedImageAttachmentNotice(count: number): string {
  return [
    "<omitted-image-attachments>",
    `count: ${count}`,
    "Slack included image attachments with this turn, but this runtime cannot analyze images because no vision model is configured.",
    "Do not claim that no image was attached.",
    "If the user asks about image contents, explain that image analysis is unavailable in this runtime and continue with any text or non-image files that are still available.",
    "</omitted-image-attachments>",
  ].join("\n");
}

function trimRouterAttachmentText(text: string): string {
  const normalized = text.replaceAll("\0", " ").trim();
  if (!normalized) {
    return "";
  }
  return normalized.length <= MAX_ROUTER_ATTACHMENT_PREVIEW_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_ROUTER_ATTACHMENT_PREVIEW_CHARS)}...`;
}

function supportsRouterTextPreview(mediaType: string): boolean {
  const baseMediaType = mediaType.split(";", 1)[0]?.trim().toLowerCase();
  if (!baseMediaType) {
    return false;
  }
  return (
    baseMediaType.startsWith("text/") ||
    baseMediaType === "application/json" ||
    baseMediaType === "application/xml" ||
    baseMediaType === "application/x-www-form-urlencoded" ||
    baseMediaType.endsWith("+json") ||
    baseMediaType.endsWith("+xml")
  );
}

function buildRouterAttachmentBlock(
  attachment: ReplyRequestAttachment,
): string {
  if (attachment.promptText) {
    return trimRouterAttachmentText(attachment.promptText);
  }

  const header = [
    "<attachment>",
    `filename: ${attachment.filename ?? "unnamed"}`,
    `media_type: ${attachment.mediaType}`,
  ];

  if (attachment.data && supportsRouterTextPreview(attachment.mediaType)) {
    const preview = trimRouterAttachmentText(attachment.data.toString("utf8"));
    if (preview) {
      return [
        ...header,
        "<text-preview>",
        preview,
        "</text-preview>",
        "</attachment>",
      ].join("\n");
    }
  }

  return [...header, "</attachment>"].join("\n");
}

/** Build the Pi user message parts and router-only attachment blocks for a turn. */
export function buildUserTurnInput(args: {
  omittedImageAttachmentCount: number;
  userAttachments?: ReplyRequestAttachment[];
  userTurnText: string;
}): {
  routerBlocks: string[];
  userContentParts: UserTurnContentPart[];
} {
  const routerBlocks: string[] = [];
  const userContentParts: UserTurnContentPart[] = [
    { type: "text", text: args.userTurnText },
  ];

  if (args.omittedImageAttachmentCount > 0) {
    const omittedImagesNotice = buildOmittedImageAttachmentNotice(
      args.omittedImageAttachmentCount,
    );
    userContentParts.push({ type: "text", text: omittedImagesNotice });
    routerBlocks.push(omittedImagesNotice);
  }

  for (const attachment of args.userAttachments ?? []) {
    routerBlocks.push(buildRouterAttachmentBlock(attachment));

    if (attachment.promptText) {
      userContentParts.push({
        type: "text",
        text: attachment.promptText,
      });
      continue;
    }

    if (attachment.mediaType.startsWith("image/")) {
      if (!attachment.data) {
        throw new Error("Image attachment is missing image data");
      }
      userContentParts.push({
        type: "image",
        data: attachment.data.toString("base64"),
        mimeType: attachment.mediaType,
      });
      continue;
    }

    if (!attachment.data) {
      throw new Error("Attachment is missing attachment data");
    }

    userContentParts.push({
      type: "text",
      text: encodeNonImageAttachmentForPrompt({
        data: attachment.data,
        mediaType: attachment.mediaType,
        filename: attachment.filename,
      }),
    });
  }

  return { routerBlocks, userContentParts };
}

/** Convert a steered user message into the Pi transcript shape. */
export function buildSteeringPiMessage(
  message: ReplySteeringMessageInput,
): PiMessage {
  const { userContentParts } = buildUserTurnInput({
    userTurnText: message.text,
    userAttachments: message.userAttachments,
    omittedImageAttachmentCount: message.omittedImageAttachmentCount ?? 0,
  });
  return {
    role: "user",
    content: userContentParts,
    timestamp: message.timestampMs ?? Date.now(),
  } as PiMessage;
}
