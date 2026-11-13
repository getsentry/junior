import { getSlackFileId } from "./attachments";
import type { Attachment } from "chat";
import { botConfig } from "@/chat/config";
import type { completeText, ConversationModelCost } from "@/chat/core-model";
import { resolveGatewayModel } from "@/chat/pi/client";
import type { ThreadConversationState } from "@/chat/state/conversation";
import { getSqlExecutor } from "@/chat/db";
import {
  detectImageMediaType,
  isVisionImageMediaType,
} from "@/chat/attachments/media";
import {
  buildStoredAttachmentPromptText,
  MAX_MODEL_ATTACHMENT_BYTES,
  MAX_MODEL_ATTACHMENTS,
} from "@/chat/attachments/model-input";
import { MAX_ATTACHMENT_BYTES } from "@/chat/attachments/input";
import { storeAttachment, type AttachmentFile } from "@/chat/attachments/store";
import { streamPrivateSlackFile } from "@/chat/slack/client";
import {
  readAttachmentVisionSummary,
  recordSlackAttachment,
} from "@/chat/slack/attachments";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import { toOptionalString } from "@/chat/coerce";
import { logInfo, logWarn } from "@/chat/logging";
import { parseSlackChannelId, type SlackChannelId } from "@/chat/slack/ids";
import {
  parseSlackMessageTs,
  type SlackMessageTs,
} from "@/chat/slack/timestamp";
import {
  getConversationMessageSlackTs,
  isHumanConversationMessage,
} from "@/chat/services/conversation-memory";

export interface UserInputAttachment {
  attachmentId?: string;
  data?: Buffer;
  mediaType: string;
  filename?: string;
  promptText?: string;
}

interface VisionThreadFile {
  id?: string;
  mimetype?: string;
  name?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
}

interface VisionThreadReply {
  ts?: string;
  subtype?: string;
  bot_id?: string;
  files?: VisionThreadFile[];
}

/**
 * Largest non-image Slack file that Junior stores when the message arrives.
 * A larger one gets a row and a loadAttachment pointer but is never stored:
 * each load or dashboard download streams it from Slack, so it costs no
 * storage, and an unused recording costs no download.
 */
export const MAX_EAGER_SLACK_FILE_BYTES = 25 * 1024 * 1024;
const MAX_MESSAGE_IMAGE_ATTACHMENTS = 3;
const MAX_VISION_SUMMARY_CHARS = 500;

export interface VisionContextDeps {
  attachmentStorage?: AttachmentStorage;
  completeText: typeof completeText;
  downloadFile: (url: string) => Promise<Buffer>;
  listThreadReplies: (input: {
    channelId: SlackChannelId;
    threadTs: SlackMessageTs;
    limit?: number;
    maxPages?: number;
    targetMessageTs?: string[];
  }) => Promise<VisionThreadReply[]>;
}

export interface VisionContextService {
  hydrateConversationVisionContext: (
    conversation: ThreadConversationState,
    context: {
      conversationId?: string;
      threadId?: string;
      channelId?: string;
      actorId?: string;
      runId?: string;
      threadTs?: string;
    },
  ) => Promise<void>;
  resolveUserAttachments: (
    attachments: Attachment[] | undefined,
    context: ResolveUserAttachmentsContext,
  ) => Promise<UserInputAttachment[]>;
}

interface ResolveUserAttachmentsContext {
  conversationId?: string;
  threadId?: string;
  actorId?: string;
  channelId?: string;
  runId?: string;
  conversation?: ThreadConversationState;
  messageTs?: string;
}

/** Report whether the current Slack message carries an image that needs vision hydration. */
export function hasPotentialImageAttachment(
  attachments: Attachment[] | undefined,
): boolean {
  return countPotentialImageAttachments(attachments) > 0;
}

/** Count image-bearing Slack attachments before vision filtering removes them. */
export function countPotentialImageAttachments(
  attachments: Attachment[] | undefined,
): number {
  return (
    attachments?.filter((attachment) =>
      isVisionImageMediaType(attachment.mimeType ?? ""),
    ).length ?? 0
  );
}

/** Report whether a dedicated vision model is configured for image analysis. */
export function isVisionEnabled(): boolean {
  return Boolean(botConfig.visionModelId);
}

/** Report whether the main agent model accepts image input. */
function agentModelAcceptsImages(): boolean {
  return resolveGatewayModel(botConfig.modelId).input.includes("image");
}

/** Report whether the agent can read current-message images by any path. */
export function canReadImages(): boolean {
  return isVisionEnabled() || agentModelAcceptsImages();
}

class ImageAttachmentProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageAttachmentProcessingError";
  }
}

function buildImageAttachmentPromptText(args: {
  attachmentId?: string;
  filename?: string;
  mediaType: string;
  summary: string;
}): string {
  return [
    "<image-attachment>",
    `filename: ${args.filename ?? "unnamed"}`,
    `media_type: ${args.mediaType}`,
    ...(args.attachmentId
      ? [
          `attachment_id: ${args.attachmentId}`,
          "Use loadAttachment with this id when the task needs the original file.",
        ]
      : []),
    "<summary>",
    args.summary,
    "</summary>",
    "</image-attachment>",
  ].join("\n");
}

function buildImageAttachmentFailurePromptText(args: {
  attachmentId?: string;
  filename?: string;
  mediaType: string;
  message: string;
}): string {
  return [
    "<image-attachment>",
    `filename: ${args.filename ?? "unnamed"}`,
    `media_type: ${args.mediaType}`,
    ...(args.attachmentId
      ? [
          `attachment_id: ${args.attachmentId}`,
          "Use loadAttachment with this id to access the original file.",
        ]
      : []),
    "<analysis-error>",
    args.message,
    "</analysis-error>",
    "</image-attachment>",
  ].join("\n");
}

function buildAttachmentResolutionFailurePromptText(args: {
  filename?: string;
  mediaType: string;
  problem: string;
}): string {
  return [
    "<attachment>",
    `filename: ${args.filename ?? "unnamed"}`,
    `media_type: ${args.mediaType}`,
    "<resolution-error>",
    `The user attached this file, but ${args.problem}. Tell the user the ` +
      "attachment could not be read; do not say no attachment was sent.",
    "</resolution-error>",
    "</attachment>",
  ].join("\n");
}

/** Point the model at a stored file, or say that the file could not be stored. */
function buildFileReferencePromptText(args: {
  attachmentId?: string;
  filename?: string;
  mediaType: string;
}): string {
  return args.attachmentId
    ? buildStoredAttachmentPromptText({
        attachmentId: args.attachmentId,
        filename: args.filename,
        mediaType: args.mediaType,
      })
    : buildAttachmentResolutionFailurePromptText({
        filename: args.filename,
        mediaType: args.mediaType,
        problem: "it could not be stored, so you cannot open it",
      });
}

// Without a stored Conversation, such as a local run, the cost stays on the
// span.
function visionCost(conversationId: string | undefined): ConversationModelCost {
  return conversationId ? { conversationId } : { owner: "none" };
}

async function summarizeImageWithVision(args: {
  completeText: typeof completeText;
  cost: ConversationModelCost;
  imageData: Buffer;
  mimeType: string;
  maxTokens: number;
  prompt: string;
  metadata: Record<string, string>;
}): Promise<string | undefined> {
  const visionModelId = botConfig.visionModelId;
  if (!visionModelId) {
    return undefined;
  }

  const result = await args.completeText({
    modelId: visionModelId,
    maxTokens: args.maxTokens,
    operation: "vision_summary",
    cost: args.cost,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: args.prompt,
          },
          {
            type: "image",
            data: args.imageData.toString("base64"),
            mimeType: args.mimeType,
          },
        ],
        timestamp: Date.now(),
      },
    ],
    metadata: {
      modelId: visionModelId,
      ...args.metadata,
    },
  });
  const summary = result.text.trim().replace(/\s+/g, " ");
  return summary || undefined;
}

function truncateVisionSummary(summary: string): string {
  return summary.slice(0, MAX_VISION_SUMMARY_CHARS);
}

function getCachedImageSummaries(args: {
  conversation?: ThreadConversationState;
  messageTs?: string;
}): Array<string | undefined> {
  if (!args.conversation || !args.messageTs) {
    return [];
  }

  const conversationMessage = args.conversation.messages.find(
    (message) => getConversationMessageSlackTs(message) === args.messageTs,
  );
  if (!conversationMessage) {
    return [];
  }

  return (conversationMessage.meta?.imageFileIds ?? []).map((fileId) =>
    args.conversation?.vision.byFileId[fileId]?.summary?.trim(),
  );
}

function createImageAttachmentProcessingError(attachment: {
  filename?: string;
}): ImageAttachmentProcessingError {
  const label = attachment.filename ? `"${attachment.filename}"` : "this image";
  return new ImageAttachmentProcessingError(
    `Image attachment ${label} arrived, but the vision model could not read it`,
  );
}

/**
 * Store one Slack file, or return no id when it cannot be stored. The model
 * then gets a note that it cannot open the file.
 */
async function storeSlackFile(args: {
  conversationId: string;
  file: AttachmentFile;
  storage: AttachmentStorage;
}): Promise<string | undefined> {
  try {
    const stored = await storeAttachment({
      conversationId: args.conversationId,
      db: getSqlExecutor(),
      file: args.file,
      storage: args.storage,
    });
    return stored.id;
  } catch (error) {
    logWarn("attachment.storage.failed", {
      "exception.message":
        error instanceof Error ? error.message : String(error),
      "app.file.mime_type": args.file.mimeType,
      "file.name": args.file.filename,
    });
    return undefined;
  }
}

async function resolveUserAttachmentsWithDeps(
  attachments: Attachment[] | undefined,
  context: ResolveUserAttachmentsContext,
  deps: Pick<VisionContextDeps, "attachmentStorage" | "completeText">,
): Promise<UserInputAttachment[]> {
  if (!attachments || attachments.length === 0) {
    return [];
  }

  const results: UserInputAttachment[] = [];
  // Only images count against the cap. Every other file, and every image past
  // the cap, still gets a note, so the model never misses an attachment.
  let modelImageCount = 0;
  const cachedImageSummaries = getCachedImageSummaries({
    conversation: context.conversation,
    messageTs: context.messageTs,
  });
  let nextCachedImageSummaryIndex = 0;

  for (const attachment of attachments) {
    const mediaType = attachment.mimeType ?? "application/octet-stream";
    const isImageAttachment = isVisionImageMediaType(mediaType);
    const declaredBytes =
      typeof attachment.size === "number" && Number.isFinite(attachment.size)
        ? attachment.size
        : undefined;
    if (declaredBytes !== undefined && declaredBytes > MAX_ATTACHMENT_BYTES) {
      logWarn("attachment.size_limit.refused", {
        "file.size": declaredBytes,
        "app.file.mime_type": mediaType,
      });
      results.push({
        mediaType,
        filename: attachment.name,
        promptText: buildAttachmentResolutionFailurePromptText({
          filename: attachment.name,
          mediaType,
          problem: `it is larger than the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB file limit, so it was not downloaded and you cannot open it`,
        }),
      });
      continue;
    }

    const slackFileId = getSlackFileId(attachment);
    const url = attachment.url;
    // Only an image that may go to the model inline needs its bytes in
    // memory. Stream every other Slack file into storage, or record a large
    // one without storing it; each read downloads it from Slack.
    if (
      context.conversationId &&
      deps.attachmentStorage &&
      slackFileId &&
      url &&
      declaredBytes !== undefined &&
      !(attachment.data instanceof Buffer) &&
      !(isImageAttachment && declaredBytes <= MAX_MODEL_ATTACHMENT_BYTES)
    ) {
      const file = {
        bytes: declaredBytes,
        filename: attachment.name ?? "attachment",
        mimeType: mediaType,
        source: { id: slackFileId, provider: "slack" },
      };
      const attachmentId = await storeSlackFile({
        conversationId: context.conversationId,
        file:
          !isImageAttachment && declaredBytes > MAX_EAGER_SLACK_FILE_BYTES
            ? { ...file, deferred: true }
            : { ...file, open: () => streamPrivateSlackFile(url) },
        storage: deps.attachmentStorage,
      });
      results.push({
        attachmentId,
        mediaType,
        filename: attachment.name,
        promptText: attachmentId
          ? buildStoredAttachmentPromptText({
              attachmentId,
              filename: attachment.name,
              mediaType,
            })
          : buildAttachmentResolutionFailurePromptText({
              filename: attachment.name,
              mediaType,
              problem:
                "it could not be downloaded from Slack and stored, so you cannot open it",
            }),
      });
      continue;
    }

    let data: Buffer;
    try {
      if (attachment.fetchData) {
        data = await attachment.fetchData();
      } else if (attachment.data instanceof Buffer) {
        data = attachment.data;
      } else {
        continue;
      }
    } catch (error) {
      logWarn("attachment.resolution.failed", {
        "exception.message":
          error instanceof Error ? error.message : String(error),
        "app.file.mime_type": mediaType,
      });
      // The user really did attach a file; only its bytes are unreachable.
      // Tell the model that instead of dropping the attachment silently, so
      // Junior does not falsely claim no attachment was sent.
      results.push({
        mediaType,
        filename: attachment.name,
        promptText: buildAttachmentResolutionFailurePromptText({
          filename: attachment.name,
          mediaType,
          problem: "you could not download its content from Slack",
        }),
      });
      continue;
    }

    const attachmentId =
      context.conversationId && deps.attachmentStorage
        ? await storeSlackFile({
            conversationId: context.conversationId,
            file: {
              data,
              filename: attachment.name ?? "attachment",
              mimeType: mediaType,
              ...(slackFileId
                ? { source: { id: slackFileId, provider: "slack" } }
                : undefined),
            },
            storage: deps.attachmentStorage,
          })
        : undefined;

    // Only images go to the model inline. Any other file, such as a video, a
    // recording, or a PDF, gets the same loadAttachment pointer as a web file.
    // So do images past the size limit or the per-turn image cap.
    if (
      !isImageAttachment ||
      data.byteLength > MAX_MODEL_ATTACHMENT_BYTES ||
      modelImageCount >= MAX_MODEL_ATTACHMENTS
    ) {
      if (isImageAttachment && data.byteLength > MAX_MODEL_ATTACHMENT_BYTES) {
        logWarn("attachment.size_limit.skipped", {
          "file.size": data.byteLength,
          "app.file.mime_type": mediaType,
        });
      }
      results.push({
        attachmentId,
        mediaType,
        filename: attachment.name,
        promptText: buildFileReferencePromptText({
          attachmentId,
          filename: attachment.name,
          mediaType,
        }),
      });
      continue;
    }
    modelImageCount += 1;

    const resolvedAttachment: UserInputAttachment = {
      attachmentId,
      mediaType,
      filename: attachment.name,
    };
    // Providers reject an image whose bytes do not match its media type, so
    // send the detected type. Slack's declared type can be wrong.
    const nativeImageMediaType =
      isImageAttachment && agentModelAcceptsImages()
        ? detectImageMediaType(data)
        : undefined;
    if (nativeImageMediaType) {
      // Keep later cached summaries aligned with their attachment positions.
      nextCachedImageSummaryIndex += 1;
      resolvedAttachment.mediaType = nativeImageMediaType;
      resolvedAttachment.data = data;
      results.push(resolvedAttachment);
      continue;
    }

    if (isImageAttachment && isVisionEnabled()) {
      const storedVisionSummary = attachmentId
        ? await readAttachmentVisionSummary({
            attachmentId,
            conversationId: context.conversationId!,
            db: getSqlExecutor(),
          })
        : undefined;
      const cachedSummary =
        storedVisionSummary ??
        cachedImageSummaries[nextCachedImageSummaryIndex];
      nextCachedImageSummaryIndex += 1;
      if (cachedSummary) {
        resolvedAttachment.promptText = buildImageAttachmentPromptText({
          attachmentId,
          filename: attachment.name,
          mediaType,
          summary: cachedSummary,
        });
        results.push(resolvedAttachment);
        continue;
      }

      try {
        const summary = await summarizeImageWithVision({
          completeText: deps.completeText,
          cost: visionCost(context.conversationId),
          imageData: data,
          mimeType: mediaType,
          maxTokens: 220,
          prompt: [
            "Describe this image with concise facts that help answer the user's request.",
            "Include visible text, UI state, charts, diagrams, errors, and names.",
            "Do not guess.",
            "Return plain text only.",
          ].join(" "),
          metadata: {
            threadId: context.threadId ?? "",
            channelId: context.channelId ?? "",
            actorId: context.actorId ?? "",
            runId: context.runId ?? "",
            filename: attachment.name ?? "",
          },
        });
        if (!summary) {
          throw createImageAttachmentProcessingError({
            filename: attachment.name,
          });
        }
        const truncatedSummary = truncateVisionSummary(summary);
        resolvedAttachment.promptText = buildImageAttachmentPromptText({
          attachmentId,
          filename: attachment.name,
          mediaType,
          summary: truncatedSummary,
        });
        if (attachmentId) {
          await recordSlackAttachment({
            attachmentId,
            conversationId: context.conversationId!,
            db: getSqlExecutor(),
            visionSummary: truncatedSummary,
          });
        }
      } catch (error) {
        const attachmentError =
          error instanceof ImageAttachmentProcessingError
            ? error
            : createImageAttachmentProcessingError({
                filename: attachment.name,
              });
        logWarn("image.attachment.processing.failed", {
          "exception.message":
            error instanceof Error ? error.message : String(error),
          "app.file.mime_type": mediaType,
          ...(attachment.name ? { "file.name": attachment.name } : undefined),
        });
        resolvedAttachment.promptText = buildImageAttachmentFailurePromptText({
          attachmentId,
          filename: attachment.name,
          mediaType,
          message: attachmentError.message,
        });
      }
      results.push(resolvedAttachment);
      continue;
    }

    if (attachmentId) {
      resolvedAttachment.promptText = buildStoredAttachmentPromptText({
        attachmentId,
        filename: attachment.name,
        mediaType,
      });
    } else {
      resolvedAttachment.data = data;
    }
    results.push(resolvedAttachment);
  }

  return results;
}

async function summarizeConversationImage(
  args: {
    imageData: Buffer;
    mimeType: string;
    fileId: string;
    context: {
      conversationId?: string;
      threadId?: string;
      channelId?: string;
      actorId?: string;
      runId?: string;
    };
  },
  deps: VisionContextDeps,
): Promise<string | undefined> {
  const visionModelId = botConfig.visionModelId;
  if (!visionModelId) {
    return undefined;
  }

  try {
    const summary = await summarizeImageWithVision({
      completeText: deps.completeText,
      cost: visionCost(args.context.conversationId),
      imageData: args.imageData,
      mimeType: args.mimeType,
      maxTokens: 220,
      prompt: [
        "Extract concise, factual context from this image for future thread turns.",
        "Focus on visible text, names, titles, companies, and candidate-identifying details.",
        "Do not speculate.",
        "Return plain text only.",
      ].join(" "),
      metadata: {
        threadId: args.context.threadId ?? "",
        channelId: args.context.channelId ?? "",
        actorId: args.context.actorId ?? "",
        runId: args.context.runId ?? "",
        fileId: args.fileId,
      },
    });
    if (!summary) {
      return undefined;
    }
    return truncateVisionSummary(summary);
  } catch (error) {
    logWarn("conversation.image.vision.failed", {
      "exception.message":
        error instanceof Error ? error.message : String(error),
      "app.file.id": args.fileId,
      "app.file.mime_type": args.mimeType,
    });
    return undefined;
  }
}

async function hydrateConversationVisionContextWithDeps(
  conversation: ThreadConversationState,
  context: {
    conversationId?: string;
    threadId?: string;
    channelId?: string;
    actorId?: string;
    runId?: string;
    threadTs?: string;
  },
  deps: VisionContextDeps,
): Promise<void> {
  if (!isVisionEnabled()) {
    return;
  }

  if (!context.channelId || !context.threadTs) {
    return;
  }
  const channelId = parseSlackChannelId(context.channelId);
  if (!channelId) {
    return;
  }
  const threadTs = parseSlackMessageTs(context.threadTs);
  if (!threadTs) {
    return;
  }

  const messagesByTs = new Map<
    string,
    (typeof conversation.messages)[number]
  >();
  for (const message of conversation.messages) {
    if (!isHumanConversationMessage(message)) continue;
    const missingCachedSummary = (message.meta?.imageFileIds ?? []).some(
      (fileId) => !conversation.vision.byFileId[fileId],
    );
    if (message.meta?.imagesHydrated && !missingCachedSummary) continue;
    const slackTs = getConversationMessageSlackTs(message);
    if (!slackTs) continue;
    messagesByTs.set(slackTs, message);
  }
  if (messagesByTs.size === 0) {
    return;
  }

  let replies: VisionThreadReply[];
  try {
    replies = await deps.listThreadReplies({
      channelId,
      threadTs,
      limit: 1000,
      maxPages: 10,
      targetMessageTs: [...messagesByTs.keys()],
    });
  } catch (error) {
    logWarn("conversation.image.replies_fetch.failed", {
      "exception.message":
        error instanceof Error ? error.message : String(error),
    });
    return;
  }

  let cacheHits = 0;
  let cacheMisses = 0;
  let analyzed = 0;
  const hydratedMessageIds = new Set<string>();

  for (const reply of replies) {
    const ts = toOptionalString(reply.ts);
    if (!ts || reply.bot_id || reply.subtype === "bot_message") {
      continue;
    }

    const conversationMessage = messagesByTs.get(ts);
    if (!conversationMessage) {
      continue;
    }
    hydratedMessageIds.add(conversationMessage.id);
    const existingMeta = conversationMessage.meta ?? {};

    const imageFiles = (reply.files ?? [])
      .filter((file) => {
        const mimeType = toOptionalString(file.mimetype);
        return Boolean(
          toOptionalString(file.id) &&
          mimeType &&
          isVisionImageMediaType(mimeType),
        );
      })
      .slice(0, MAX_MESSAGE_IMAGE_ATTACHMENTS);
    if (imageFiles.length === 0) {
      conversationMessage.meta = {
        ...existingMeta,
        slackTs: existingMeta.slackTs ?? ts,
        imagesHydrated: true,
      };
      continue;
    }

    const imageFileIds = imageFiles
      .map((file) => toOptionalString(file.id))
      .filter((fileId): fileId is string => Boolean(fileId));
    conversationMessage.meta = {
      ...existingMeta,
      slackTs: existingMeta.slackTs ?? ts,
      imageFileIds,
      imagesHydrated: true,
    };

    for (const file of imageFiles) {
      const fileId = toOptionalString(file.id);
      if (!fileId) continue;

      if (conversation.vision.byFileId[fileId]) {
        cacheHits += 1;
        continue;
      }
      cacheMisses += 1;

      const mimeType =
        toOptionalString(file.mimetype) ?? "application/octet-stream";
      const fileSize =
        typeof file.size === "number" && Number.isFinite(file.size)
          ? file.size
          : undefined;
      if (fileSize && fileSize > MAX_MODEL_ATTACHMENT_BYTES) {
        logWarn("conversation.image.size_limit.skipped", {
          "app.file.id": fileId,
          "file.size": fileSize,
          "app.file.mime_type": mimeType,
        });
        continue;
      }

      const downloadUrl =
        toOptionalString(file.url_private_download) ??
        toOptionalString(file.url_private);
      if (!downloadUrl) {
        continue;
      }

      let imageData: Buffer;
      try {
        imageData = await deps.downloadFile(downloadUrl);
      } catch (error) {
        logWarn("conversation.image.download.failed", {
          "exception.message":
            error instanceof Error ? error.message : String(error),
          "app.file.id": fileId,
          "app.file.mime_type": mimeType,
        });
        continue;
      }

      if (imageData.byteLength > MAX_MODEL_ATTACHMENT_BYTES) {
        logWarn("conversation.image.size_limit.skipped", {
          "app.file.id": fileId,
          "file.size": imageData.byteLength,
          "app.file.mime_type": mimeType,
        });
        continue;
      }

      const summary = await summarizeConversationImage(
        {
          imageData,
          mimeType,
          fileId,
          context,
        },
        deps,
      );
      if (!summary) {
        continue;
      }

      conversation.vision.byFileId[fileId] = {
        summary,
        analyzedAtMs: Date.now(),
      };
      analyzed += 1;
    }
  }

  if (
    cacheHits > 0 ||
    cacheMisses > 0 ||
    analyzed > 0 ||
    hydratedMessageIds.size > 0
  ) {
    logInfo("conversation.image.context.hydrated", {
      "app.conversation_image.cache_hits": cacheHits,
      "app.conversation_image.cache_misses": cacheMisses,
      "app.conversation_image.analyzed": analyzed,
      "app.conversation_image.messages_hydrated": hydratedMessageIds.size,
    });
  }

  if (!conversation.vision.backfillCompletedAtMs) {
    conversation.vision.backfillCompletedAtMs = Date.now();
  }
}

/** Build the vision service that owns thread image hydration and attachment preprocessing. */
export function createVisionContextService(
  deps: VisionContextDeps,
): VisionContextService {
  return {
    resolveUserAttachments: async (attachments, context) =>
      await resolveUserAttachmentsWithDeps(attachments, context, deps),
    hydrateConversationVisionContext: async (conversation, context) =>
      await hydrateConversationVisionContextWithDeps(
        conversation,
        context,
        deps,
      ),
  };
}
