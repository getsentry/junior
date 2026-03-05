import type { Attachment } from "chat";
import { botConfig } from "@/chat/config";
import type { ThreadConversationState } from "@/chat/conversation-state";
import { logInfo, logWarn, toOptionalString } from "@/chat/observability";
import { getBotDeps } from "@/chat/runtime/deps";
import type { listThreadReplies } from "@/chat/slack-actions/channel";
import {
  getConversationMessageSlackTs,
  isHumanConversationMessage,
  updateConversationStats
} from "@/chat/services/conversation-memory";

export interface UserInputAttachment {
  data: Buffer;
  mediaType: string;
  filename?: string;
}

const MAX_USER_ATTACHMENTS = 3;
const MAX_USER_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_MESSAGE_IMAGE_ATTACHMENTS = 3;
const MAX_VISION_SUMMARY_CHARS = 500;

export async function resolveUserAttachments(
  attachments: Attachment[] | undefined,
  context: {
    threadId?: string;
    requesterId?: string;
    channelId?: string;
    runId?: string;
  }
): Promise<UserInputAttachment[]> {
  if (!attachments || attachments.length === 0) {
    return [];
  }

  const results: UserInputAttachment[] = [];
  for (const attachment of attachments) {
    if (results.length >= MAX_USER_ATTACHMENTS) break;
    if (attachment.type !== "image" && attachment.type !== "file") continue;

    const mediaType = attachment.mimeType ?? "application/octet-stream";

    try {
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
            modelId: botConfig.modelId
          },
          {
            "file.size": data.byteLength,
            "file.mime_type": mediaType
          },
          "Skipping user attachment that exceeds size limit"
        );
        continue;
      }

      results.push({
        data,
        mediaType,
        filename: attachment.name
      });
    } catch (error) {
      logWarn(
        "attachment_resolution_failed",
        {
          slackThreadId: context.threadId,
          slackUserId: context.requesterId,
          slackChannelId: context.channelId,
          runId: context.runId,
          assistantUserName: botConfig.userName,
          modelId: botConfig.modelId
        },
        {
          "error.message": error instanceof Error ? error.message : String(error),
          "file.mime_type": mediaType
        },
        "Failed to resolve user attachment"
      );
    }
  }

  return results;
}

async function summarizeConversationImage(args: {
  imageData: Buffer;
  mimeType: string;
  fileId: string;
  context: {
    threadId?: string;
    channelId?: string;
    requesterId?: string;
    runId?: string;
  };
}): Promise<string | undefined> {
  try {
    const result = await getBotDeps().completeText({
      modelId: botConfig.modelId,
      temperature: 0,
      maxTokens: 220,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "Extract concise, factual context from this image for future thread turns.",
                "Focus on visible text, names, titles, companies, and candidate-identifying details.",
                "Do not speculate.",
                "Return plain text only."
              ].join(" ")
            },
            {
              type: "image",
              data: args.imageData.toString("base64"),
              mimeType: args.mimeType
            }
          ],
          timestamp: Date.now()
        }
      ],
      metadata: {
        modelId: botConfig.modelId,
        threadId: args.context.threadId ?? "",
        channelId: args.context.channelId ?? "",
        requesterId: args.context.requesterId ?? "",
        runId: args.context.runId ?? "",
        fileId: args.fileId
      }
    });
    const summary = result.text.trim().replace(/\s+/g, " ");
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
        modelId: botConfig.modelId
      },
      {
        "error.message": error instanceof Error ? error.message : String(error),
        "file.id": args.fileId,
        "file.mime_type": args.mimeType
      },
      "Image analysis failed while hydrating conversation context"
    );
    return undefined;
  }
}

export async function hydrateConversationVisionContext(
  conversation: ThreadConversationState,
  context: {
    threadId?: string;
    channelId?: string;
    requesterId?: string;
    runId?: string;
    threadTs?: string;
  }
): Promise<void> {
  if (!context.channelId || !context.threadTs) {
    return;
  }

  const messagesByTs = new Map<string, (typeof conversation.messages)[number]>();
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
    replies = await getBotDeps().listThreadReplies({
      channelId: context.channelId,
      threadTs: context.threadTs,
      limit: 1000,
      maxPages: 10,
      targetMessageTs: [...messagesByTs.keys()]
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
        modelId: botConfig.modelId
      },
      {
        "error.message": error instanceof Error ? error.message : String(error)
      },
      "Failed to fetch thread replies for image context hydration"
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
        return Boolean(toOptionalString(file.id) && mimeType?.startsWith("image/"));
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
      imagesHydrated: true
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

      const mimeType = toOptionalString(file.mimetype) ?? "application/octet-stream";
      const fileSize = typeof file.size === "number" && Number.isFinite(file.size) ? file.size : undefined;
      if (fileSize && fileSize > MAX_USER_ATTACHMENT_BYTES) {
        logWarn(
          "conversation_image_skipped_size_limit",
          {
            slackThreadId: context.threadId,
            slackUserId: context.requesterId,
            slackChannelId: context.channelId,
            runId: context.runId,
            assistantUserName: botConfig.userName,
            modelId: botConfig.modelId
          },
          {
            "file.id": fileId,
            "file.size": fileSize,
            "file.mime_type": mimeType
          },
          "Skipping thread image that exceeds size limit"
        );
        continue;
      }

      const downloadUrl = toOptionalString(file.url_private_download) ?? toOptionalString(file.url_private);
      if (!downloadUrl) {
        continue;
      }

      let imageData: Buffer;
      try {
        imageData = await getBotDeps().downloadPrivateSlackFile(downloadUrl);
      } catch (error) {
        logWarn(
          "conversation_image_download_failed",
          {
            slackThreadId: context.threadId,
            slackUserId: context.requesterId,
            slackChannelId: context.channelId,
            runId: context.runId,
            assistantUserName: botConfig.userName,
            modelId: botConfig.modelId
          },
          {
            "error.message": error instanceof Error ? error.message : String(error),
            "file.id": fileId,
            "file.mime_type": mimeType
          },
          "Failed to download thread image for context hydration"
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
            modelId: botConfig.modelId
          },
          {
            "file.id": fileId,
            "file.size": imageData.byteLength,
            "file.mime_type": mimeType
          },
          "Skipping downloaded thread image that exceeds size limit"
        );
        continue;
      }

      const summary = await summarizeConversationImage({
        imageData,
        mimeType,
        fileId,
        context
      });
      if (!summary) {
        continue;
      }

      conversation.vision.byFileId[fileId] = {
        summary,
        analyzedAtMs: Date.now()
      };
      analyzed += 1;
      mutated = true;
    }
  }

  if (mutated) {
    updateConversationStats(conversation);
  }

  if (cacheHits > 0 || cacheMisses > 0 || analyzed > 0 || hydratedMessageIds.size > 0) {
    logInfo(
      "conversation_image_context_hydrated",
      {
        slackThreadId: context.threadId,
        slackUserId: context.requesterId,
        slackChannelId: context.channelId,
        runId: context.runId,
        assistantUserName: botConfig.userName,
        modelId: botConfig.modelId
      },
      {
        "app.conversation_image.cache_hits": cacheHits,
        "app.conversation_image.cache_misses": cacheMisses,
        "app.conversation_image.analyzed": analyzed,
        "app.conversation_image.messages_hydrated": hydratedMessageIds.size
      },
      "Hydrated conversation image context"
    );
  }

  if (!conversation.vision.backfillCompletedAtMs) {
    conversation.vision.backfillCompletedAtMs = Date.now();
  }
}
