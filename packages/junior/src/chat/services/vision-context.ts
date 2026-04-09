import type { Attachment } from "chat";
import { botConfig } from "@/chat/config";
import { completeText } from "@/chat/pi/client";
import type { ThreadConversationState } from "@/chat/state/conversation";
import { toOptionalString } from "@/chat/coerce";
import { logInfo, logWarn } from "@/chat/logging";
import { listThreadReplies } from "@/chat/slack/channel";
import { downloadPrivateSlackFile } from "@/chat/slack/client";
import {
  getConversationMessageSlackTs,
  isHumanConversationMessage,
  updateConversationStats,
} from "@/chat/services/conversation-memory";

export interface UserInputAttachment {
  data?: Buffer;
  mediaType: string;
  filename?: string;
  promptText?: string;
}

const MAX_USER_ATTACHMENTS = 3;
const MAX_USER_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_MESSAGE_IMAGE_ATTACHMENTS = 3;
const MAX_VISION_SUMMARY_CHARS = 500;

export interface VisionContextDeps {
  completeText: typeof completeText;
  downloadPrivateSlackFile: typeof downloadPrivateSlackFile;
  listThreadReplies: typeof listThreadReplies;
}

export interface VisionContextService {
  hydrateConversationVisionContext: (
    conversation: ThreadConversationState,
    context: {
      threadId?: string;
      channelId?: string;
      requesterId?: string;
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
  threadId?: string;
  requesterId?: string;
  channelId?: string;
  runId?: string;
  conversation?: ThreadConversationState;
  messageTs?: string;
}

/** Report whether a dedicated vision model is configured for image analysis. */
export function isVisionEnabled(): boolean {
  return Boolean(botConfig.visionModelId);
}

class ImageAttachmentProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageAttachmentProcessingError";
  }
}

function buildImageAttachmentPromptText(args: {
  filename?: string;
  mediaType: string;
  summary: string;
}): string {
  return [
    "<image-attachment>",
    `filename: ${args.filename ?? "unnamed"}`,
    `media_type: ${args.mediaType}`,
    "<summary>",
    args.summary,
    "</summary>",
    "</image-attachment>",
  ].join("\n");
}

async function summarizeImageWithVision(args: {
  completeText: typeof completeText;
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
    temperature: 0,
    maxTokens: args.maxTokens,
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
    `Image attachment ${label} could not be analyzed`,
  );
}

async function resolveUserAttachmentsWithDeps(
  attachments: Attachment[] | undefined,
  context: ResolveUserAttachmentsContext,
  deps: Pick<VisionContextDeps, "completeText">,
): Promise<UserInputAttachment[]> {
  if (!attachments || attachments.length === 0) {
    return [];
  }

  const results: UserInputAttachment[] = [];
  const cachedImageSummaries = getCachedImageSummaries({
    conversation: context.conversation,
    messageTs: context.messageTs,
  });
  let nextCachedImageSummaryIndex = 0;
  for (const attachment of attachments) {
    if (results.length >= MAX_USER_ATTACHMENTS) break;
    if (attachment.type !== "image" && attachment.type !== "file") continue;

    const mediaType = attachment.mimeType ?? "application/octet-stream";
    const isImageAttachment =
      attachment.type === "image" || mediaType.startsWith("image/");
    if (isImageAttachment && !isVisionEnabled()) {
      continue;
    }

    try {
      const resolvedAttachment: UserInputAttachment = {
        mediaType,
        filename: attachment.name,
      };
      if (isImageAttachment) {
        const cachedSummary = cachedImageSummaries[nextCachedImageSummaryIndex];
        nextCachedImageSummaryIndex += 1;
        if (cachedSummary) {
          resolvedAttachment.promptText = buildImageAttachmentPromptText({
            filename: attachment.name,
            mediaType,
            summary: cachedSummary,
          });
          results.push(resolvedAttachment);
          continue;
        }

        let imageData: Buffer | null = null;
        if (attachment.fetchData) {
          imageData = await attachment.fetchData();
        } else if (attachment.data instanceof Buffer) {
          imageData = attachment.data;
        }
        if (!imageData) {
          throw createImageAttachmentProcessingError({
            filename: attachment.name,
          });
        }
        if (imageData.byteLength > MAX_USER_ATTACHMENT_BYTES) {
          throw createImageAttachmentProcessingError({
            filename: attachment.name,
          });
        }

        const summary = await summarizeImageWithVision({
          completeText: deps.completeText,
          imageData,
          mimeType: mediaType,
          maxTokens: 220,
          prompt: [
            "Extract concise, factual context from this user-provided image.",
            "Focus on visible text, UI state, charts, diagrams, errors, names, and other concrete details useful for answering the user's current request.",
            "Do not speculate.",
            "Return plain text only.",
          ].join(" "),
          metadata: {
            threadId: context.threadId ?? "",
            channelId: context.channelId ?? "",
            requesterId: context.requesterId ?? "",
            runId: context.runId ?? "",
            filename: attachment.name ?? "",
          },
        });
        if (!summary) {
          throw createImageAttachmentProcessingError({
            filename: attachment.name,
          });
        }
        resolvedAttachment.promptText = buildImageAttachmentPromptText({
          filename: attachment.name,
          mediaType,
          summary,
        });
        results.push(resolvedAttachment);
        continue;
      }

      let data: Buffer | null = null;
      if (attachment.fetchData) {
        data = await attachment.fetchData();
      } else if (attachment.data instanceof Buffer) {
        data = attachment.data;
      }

      if (!data) continue;
      if (data.byteLength > MAX_USER_ATTACHMENT_BYTES) {
        logWarn(
          "attachment_skipped_size_limit",
          {
            slackThreadId: context.threadId,
            slackUserId: context.requesterId,
            slackChannelId: context.channelId,
            runId: context.runId,
            assistantUserName: botConfig.userName,
            modelId: botConfig.modelId,
          },
          {
            "file.size": data.byteLength,
            "file.mime_type": mediaType,
          },
          "Skipping user attachment that exceeds size limit",
        );
        continue;
      }

      resolvedAttachment.data = data;
      results.push(resolvedAttachment);
    } catch (error) {
      if (isImageAttachment) {
        const attachmentError =
          error instanceof ImageAttachmentProcessingError
            ? error
            : createImageAttachmentProcessingError({
                filename: attachment.name,
              });
        logWarn(
          "image_attachment_processing_failed",
          {
            slackThreadId: context.threadId,
            slackUserId: context.requesterId,
            slackChannelId: context.channelId,
            runId: context.runId,
            assistantUserName: botConfig.userName,
            modelId: botConfig.visionModelId ?? botConfig.modelId,
          },
          {
            "error.message":
              error instanceof Error ? error.message : String(error),
            "file.mime_type": mediaType,
            ...(attachment.name ? { "file.name": attachment.name } : {}),
          },
          "Image attachment processing failed",
        );
        throw attachmentError;
      }

      logWarn(
        "attachment_resolution_failed",
        {
          slackThreadId: context.threadId,
          slackUserId: context.requesterId,
          slackChannelId: context.channelId,
          runId: context.runId,
          assistantUserName: botConfig.userName,
          modelId: botConfig.modelId,
        },
        {
          "error.message":
            error instanceof Error ? error.message : String(error),
          "file.mime_type": mediaType,
        },
        "Failed to resolve user attachment",
      );
    }
  }

  return results;
}

async function summarizeConversationImage(
  args: {
    imageData: Buffer;
    mimeType: string;
    fileId: string;
    context: {
      threadId?: string;
      channelId?: string;
      requesterId?: string;
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
        requesterId: args.context.requesterId ?? "",
        runId: args.context.runId ?? "",
        fileId: args.fileId,
      },
    });
    if (!summary) {
      return undefined;
    }
    return summary.slice(0, MAX_VISION_SUMMARY_CHARS);
  } catch (error) {
    logWarn(
      "conversation_image_vision_failed",
      {
        slackThreadId: args.context.threadId,
        slackUserId: args.context.requesterId,
        slackChannelId: args.context.channelId,
        runId: args.context.runId,
        assistantUserName: botConfig.userName,
        modelId: visionModelId,
      },
      {
        "error.message": error instanceof Error ? error.message : String(error),
        "file.id": args.fileId,
        "file.mime_type": args.mimeType,
      },
      "Image analysis failed while hydrating conversation context",
    );
    return undefined;
  }
}

async function hydrateConversationVisionContextWithDeps(
  conversation: ThreadConversationState,
  context: {
    threadId?: string;
    channelId?: string;
    requesterId?: string;
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

  const messagesByTs = new Map<
    string,
    (typeof conversation.messages)[number]
  >();
  for (const message of conversation.messages) {
    if (!isHumanConversationMessage(message)) continue;
    if (message.meta?.imagesHydrated) continue;
    const slackTs = getConversationMessageSlackTs(message);
    if (!slackTs) continue;
    messagesByTs.set(slackTs, message);
  }
  if (messagesByTs.size === 0) {
    return;
  }

  let replies: Awaited<ReturnType<typeof listThreadReplies>>;
  try {
    replies = await deps.listThreadReplies({
      channelId: context.channelId,
      threadTs: context.threadTs,
      limit: 1000,
      maxPages: 10,
      targetMessageTs: [...messagesByTs.keys()],
    });
  } catch (error) {
    logWarn(
      "conversation_image_replies_fetch_failed",
      {
        slackThreadId: context.threadId,
        slackUserId: context.requesterId,
        slackChannelId: context.channelId,
        runId: context.runId,
        assistantUserName: botConfig.userName,
        modelId: botConfig.modelId,
      },
      {
        "error.message": error instanceof Error ? error.message : String(error),
      },
      "Failed to fetch thread replies for image context hydration",
    );
    return;
  }

  let cacheHits = 0;
  let cacheMisses = 0;
  let analyzed = 0;
  let mutated = false;
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

    const imageFiles = (reply.files ?? [])
      .filter((file) => {
        const mimeType = toOptionalString(file.mimetype);
        return Boolean(
          toOptionalString(file.id) && mimeType?.startsWith("image/"),
        );
      })
      .slice(0, MAX_MESSAGE_IMAGE_ATTACHMENTS);
    if (imageFiles.length === 0) {
      continue;
    }

    const imageFileIds = imageFiles
      .map((file) => toOptionalString(file.id))
      .filter((fileId): fileId is string => Boolean(fileId));
    const existingMeta = conversationMessage.meta ?? {};
    conversationMessage.meta = {
      ...existingMeta,
      slackTs: existingMeta.slackTs ?? ts,
      imageFileIds,
      imagesHydrated: true,
    };
    mutated = true;

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
      if (fileSize && fileSize > MAX_USER_ATTACHMENT_BYTES) {
        logWarn(
          "conversation_image_skipped_size_limit",
          {
            slackThreadId: context.threadId,
            slackUserId: context.requesterId,
            slackChannelId: context.channelId,
            runId: context.runId,
            assistantUserName: botConfig.userName,
            modelId: botConfig.modelId,
          },
          {
            "file.id": fileId,
            "file.size": fileSize,
            "file.mime_type": mimeType,
          },
          "Skipping thread image that exceeds size limit",
        );
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
        imageData = await deps.downloadPrivateSlackFile(downloadUrl);
      } catch (error) {
        logWarn(
          "conversation_image_download_failed",
          {
            slackThreadId: context.threadId,
            slackUserId: context.requesterId,
            slackChannelId: context.channelId,
            runId: context.runId,
            assistantUserName: botConfig.userName,
            modelId: botConfig.modelId,
          },
          {
            "error.message":
              error instanceof Error ? error.message : String(error),
            "file.id": fileId,
            "file.mime_type": mimeType,
          },
          "Failed to download thread image for context hydration",
        );
        continue;
      }

      if (imageData.byteLength > MAX_USER_ATTACHMENT_BYTES) {
        logWarn(
          "conversation_image_skipped_size_limit",
          {
            slackThreadId: context.threadId,
            slackUserId: context.requesterId,
            slackChannelId: context.channelId,
            runId: context.runId,
            assistantUserName: botConfig.userName,
            modelId: botConfig.modelId,
          },
          {
            "file.id": fileId,
            "file.size": imageData.byteLength,
            "file.mime_type": mimeType,
          },
          "Skipping downloaded thread image that exceeds size limit",
        );
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
      mutated = true;
    }
  }

  if (mutated) {
    updateConversationStats(conversation);
  }

  if (
    cacheHits > 0 ||
    cacheMisses > 0 ||
    analyzed > 0 ||
    hydratedMessageIds.size > 0
  ) {
    logInfo(
      "conversation_image_context_hydrated",
      {
        slackThreadId: context.threadId,
        slackUserId: context.requesterId,
        slackChannelId: context.channelId,
        runId: context.runId,
        assistantUserName: botConfig.userName,
        modelId: botConfig.modelId,
      },
      {
        "app.conversation_image.cache_hits": cacheHits,
        "app.conversation_image.cache_misses": cacheMisses,
        "app.conversation_image.analyzed": analyzed,
        "app.conversation_image.messages_hydrated": hydratedMessageIds.size,
      },
      "Hydrated conversation image context",
    );
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

const defaultVisionContextService = createVisionContextService({
  completeText,
  downloadPrivateSlackFile,
  listThreadReplies,
});

export const hydrateConversationVisionContext =
  defaultVisionContextService.hydrateConversationVisionContext;
