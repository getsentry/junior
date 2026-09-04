import type { Attachment } from "chat";
import { botConfig } from "@/chat/config";
import type { completeText } from "@/chat/pi/client";
import type { ThreadConversationState } from "@/chat/state/conversation";
import { getSqlExecutor } from "@/chat/db";
import { isVisionImageMediaType } from "@/chat/attachments/media";
import {
  readLiveAttachment,
  recordSlackAttachmentMetadata,
  storeAttachment,
} from "@/chat/attachments/store";
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

const MAX_USER_ATTACHMENTS = 3;
const MAX_USER_ATTACHMENT_BYTES = 5 * 1024 * 1024;
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
    promptName: "junior.vision_summary",
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

function buildStoredAttachmentPromptText(args: {
  attachmentId: string;
  filename?: string;
  mediaType: string;
}): string {
  return [
    "<attachment>",
    `filename: ${args.filename ?? "unnamed"}`,
    `media_type: ${args.mediaType}`,
    `attachment_id: ${args.attachmentId}`,
    "Use loadAttachment with this id to access the original file.",
    "</attachment>",
  ].join("\n");
}

function getSlackFileId(attachment: Attachment): string | undefined {
  const metadataId = attachment.fetchMetadata?.fileId;
  if (metadataId) return metadataId;
  const match = (attachment.url ?? attachment.fetchMetadata?.url ?? "").match(
    /(?:^|[-/])(F[A-Z0-9]+)(?:[-/]|$)/i,
  );
  return match?.[1];
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
  deps: Pick<VisionContextDeps, "attachmentStorage" | "completeText">,
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
    const isImageAttachment = isVisionImageMediaType(mediaType);

    const resolvedAttachment: UserInputAttachment = {
      mediaType,
      filename: attachment.name,
    };
    try {
      let data: Buffer | null = null;
      if (attachment.fetchData) {
        data = await attachment.fetchData();
      } else if (attachment.data instanceof Buffer) {
        data = attachment.data;
      }
      if (!data) continue;
      if (data.byteLength > MAX_USER_ATTACHMENT_BYTES) {
        logWarn("attachment.size_limit.skipped", {
          "file.size": data.byteLength,
          "app.file.mime_type": mediaType,
        });
        continue;
      }

      const slackFileId = getSlackFileId(attachment);
      if (context.conversationId && deps.attachmentStorage) {
        const stored = await storeAttachment({
          conversationId: context.conversationId,
          db: getSqlExecutor(),
          file: {
            bytes: data.byteLength,
            data,
            filename: attachment.name ?? "attachment",
            mimeType: mediaType,
            path: attachment.name ?? "attachment",
          },
          storage: deps.attachmentStorage,
        });
        resolvedAttachment.attachmentId = stored.id;
        await recordSlackAttachmentMetadata({
          attachmentId: stored.id,
          db: getSqlExecutor(),
          ...(slackFileId ? { slackFileId } : undefined),
        });
      }

      if (isImageAttachment && isVisionEnabled()) {
        const storedAttachment = resolvedAttachment.attachmentId
          ? await readLiveAttachment({
              attachmentId: resolvedAttachment.attachmentId,
              conversationId: context.conversationId!,
              db: getSqlExecutor(),
            })
          : undefined;
        const cachedSummary =
          storedAttachment?.visionSummary ??
          cachedImageSummaries[nextCachedImageSummaryIndex];
        nextCachedImageSummaryIndex += 1;
        if (cachedSummary) {
          resolvedAttachment.promptText = buildImageAttachmentPromptText({
            attachmentId: resolvedAttachment.attachmentId,
            filename: attachment.name,
            mediaType,
            summary: cachedSummary,
          });
          results.push(resolvedAttachment);
          continue;
        }

        const summary = await summarizeImageWithVision({
          completeText: deps.completeText,
          imageData: data,
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
          filename: attachment.name,
          mediaType,
          summary: truncatedSummary,
          attachmentId: resolvedAttachment.attachmentId,
        });
        if (resolvedAttachment.attachmentId) {
          await recordSlackAttachmentMetadata({
            attachmentId: resolvedAttachment.attachmentId,
            db: getSqlExecutor(),
            visionSummary: truncatedSummary,
          });
        }
        results.push(resolvedAttachment);
        continue;
      }

      if (isImageAttachment && resolvedAttachment.attachmentId) {
        resolvedAttachment.promptText = buildStoredAttachmentPromptText({
          attachmentId: resolvedAttachment.attachmentId,
          filename: attachment.name,
          mediaType,
        });
      } else {
        resolvedAttachment.data = data;
      }
      results.push(resolvedAttachment);
    } catch (error) {
      if (isImageAttachment) {
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
        results.push({
          attachmentId: resolvedAttachment.attachmentId,
          mediaType,
          filename: attachment.name,
          promptText: buildImageAttachmentFailurePromptText({
            attachmentId: resolvedAttachment.attachmentId,
            filename: attachment.name,
            mediaType,
            message: attachmentError.message,
          }),
        });
        continue;
      }

      logWarn("attachment.resolution.failed", {
        "exception.message":
          error instanceof Error ? error.message : String(error),
        "app.file.mime_type": mediaType,
      });
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
      if (fileSize && fileSize > MAX_USER_ATTACHMENT_BYTES) {
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

      if (imageData.byteLength > MAX_USER_ATTACHMENT_BYTES) {
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
