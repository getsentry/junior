import { SlackActionError } from "@/chat/slack/client";
import { listThreadReplies } from "@/chat/slack/channel";
import {
  checkSlackChannelReadAccess,
  joinPublicChannelForRead,
} from "@/chat/slack/tool-support/channel-access";
import {
  resolveSlackChannelRef,
  slackChannelRefParam,
} from "@/chat/slack/tool-support/channel-target";
import * as z from "zod";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { parseSlackMessageReference } from "@/chat/slack/tool-support/slack-message-url";
import type { SlackToolContext } from "@/chat/slack/tool-support/context";
import {
  parseRequiredSlackTimestampParam,
  slackTimestampParam,
} from "@/chat/slack/timestamp-param";
import type { SlackChannelId, SlackTeamId } from "@/chat/slack/ids";
import type { SlackMessageTs } from "@/chat/slack/timestamp";
import type { SlackFileRef, SlackThreadReply } from "@/chat/slack/channel";
import {
  extractAttachmentFiles,
  renderAttachmentText,
} from "@/chat/slack/message/attachments";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { JuniorSqlDatabase } from "@/db/db";
import { matchSlackAttachments } from "@/chat/slack/attachments";
import { getConversationStore } from "@/chat/db";
import { downloadPrivateSlackFile } from "@/chat/slack/client";
import { storeAttachment } from "@/chat/attachments/store";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import { logWarn } from "@/chat/logging";
import { MAX_MODEL_ATTACHMENTS } from "@/chat/attachments/model-input";

interface ThreadReadAttachmentDeps {
  conversationId: string;
  db: JuniorSqlDatabase;
  storage?: AttachmentStorage;
}

/** Private file URLs get the bot token, so only send it to Slack hosts. */
function isSlackFileUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "slack.com" || url.hostname.endsWith(".slack.com"))
    );
  } catch {
    return false;
  }
}

/**
 * Store files from the current Conversation's thread that no Turn stored.
 *
 * Slack attaches a linked file after the message event, and a file can be in
 * a message that started no Turn. Storing it here gives the model an
 * `attachment_id` for `loadAttachment`. A file that fails to download stays
 * metadata-only, the same as a failed download at turn start. Callers pass
 * only files with a Slack `url_private`.
 */
async function storeThreadFiles(args: {
  conversationId: string;
  db: JuniorSqlDatabase;
  files: SlackFileRef[];
  storage: AttachmentStorage;
}): Promise<Array<readonly [string, string]>> {
  const stored: Array<readonly [string, string]> = [];
  for (const file of args.files) {
    const url = file.url_private;
    if (!file.id || !url) continue;
    const filename = file.name ?? "attachment";
    try {
      const data = await downloadPrivateSlackFile(url);
      const attachment = await storeAttachment({
        conversationId: args.conversationId,
        db: args.db,
        file: {
          bytes: data.byteLength,
          data,
          filename,
          mimeType: file.mimetype ?? "application/octet-stream",
          path: filename,
        },
        source: { id: file.id, provider: "slack" },
        storage: args.storage,
      });
      stored.push([file.id, attachment.id]);
    } catch (error) {
      logWarn("attachment.thread_read.storage.failed", {
        "exception.message":
          error instanceof Error ? error.message : String(error),
        "app.file.mime_type": file.mimetype,
      });
    }
  }
  return stored;
}

/**
 * Combine top-level `files` with files nested inside `attachments`
 * (forwarded/shared messages carry their files there), deduped by id.
 */
function collectMessageFiles(msg: SlackThreadReply): SlackFileRef[] {
  const seen = new Set<string>();
  const files: SlackFileRef[] = [];
  for (const file of [
    ...(msg.files ?? []),
    ...extractAttachmentFiles(msg.attachments),
  ]) {
    if (!file.id || seen.has(file.id)) continue;
    seen.add(file.id);
    files.push(file);
  }
  return files;
}

/** Project a thread reply to safe output fields (strips url_private etc). */
function sanitizeMessage(
  msg: SlackThreadReply,
  attachmentIdsBySlackFileId: ReadonlyMap<string, string>,
) {
  const attachmentText = renderAttachmentText(msg.attachments);
  const files = collectMessageFiles(msg);

  return {
    slack_ts: msg.ts,
    user: msg.user,
    text: msg.text,
    thread_ts: msg.thread_ts,
    subtype: msg.subtype,
    bot_id: msg.bot_id,
    type: msg.type,
    ...(msg.reactions?.length
      ? {
          reactions: msg.reactions.map((reaction) => ({
            name: reaction.name,
            count: reaction.count,
            users: reaction.users,
          })),
        }
      : undefined),
    ...(attachmentText ? { attachment_text: attachmentText } : undefined),
    ...(files.length
      ? {
          files: files.map((f) => ({
            id: f.id,
            name: f.name,
            mimetype: f.mimetype,
            size: f.size,
            ...(f.id && attachmentIdsBySlackFileId.get(f.id)
              ? { attachment_id: attachmentIdsBySlackFileId.get(f.id) }
              : undefined),
          })),
        }
      : undefined),
  };
}

/**
 * Find stored Conversations for a Slack thread.
 *
 * A thread that an automation run started is bound to the run's Conversation.
 * Other threads use `slack:<channel>:<threadTs>`. Return both when both exist.
 */
async function findThreadConversationIds(args: {
  channelId: SlackChannelId;
  teamId: SlackTeamId;
  threadTs: string;
}): Promise<string[]> {
  const store = getConversationStore();
  const boundId = await store.getConversationIdByProviderConversation({
    provider: "slack",
    providerDestinationId: args.channelId,
    providerTenantId: args.teamId,
    providerConversationId: args.threadTs,
  });
  const threadId = `slack:${args.channelId}:${args.threadTs}`;
  const ids = boundId ? [boundId] : [];
  if (threadId !== boundId && (await store.get({ conversationId: threadId }))) {
    ids.push(threadId);
  }
  return ids;
}

/** Create a tool that reads a Slack thread from a shared message URL or explicit coordinates. */
export function createSlackThreadReadTool(
  context: SlackToolContext,
  attachmentDeps?: ThreadReadAttachmentDeps,
) {
  return zodTool({
    description: `Read a Slack thread, including message reaction users, from a shared archive URL or explicit channel + timestamp. Works for the current conversation and public channels. Returns \`conversation_ids\` when you took part in the thread; pass one to \`searchConversationEvents\`. In the current conversation's thread, stores up to ${MAX_MODEL_ATTACHMENTS} new files per call and returns their \`attachment_id\` for \`loadAttachment\`; \`unstored_file_count\` counts the files left for a later call.`,
    // Not read-only: it stores files of the current thread as Conversation
    // attachments. Reading again stores nothing new for the same files.
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    inputSchema: z.object({
      url: z
        .string()
        .min(1)
        .describe("Slack message archive URL.")
        .nullable()
        .optional(),
      channel_id: slackChannelRefParam
        .describe(
          `${slackChannelRefParam.description} Defaults to the current conversation's channel.`,
        )
        .nullable()
        .optional(),
      slack_ts: slackTimestampParam(
        "Slack message timestamp. May be the thread root or any message in the thread.",
      )
        .nullable()
        .optional(),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(1000)
        .describe("Maximum number of thread messages to fetch.")
        .nullable()
        .optional(),
      max_pages: z.coerce
        .number()
        .int()
        .min(1)
        .max(10)
        .describe("Maximum number of Slack API pages to traverse.")
        .nullable()
        .optional(),
    }),
    outputSchema: juniorToolOutputSchema,
    execute: async ({ url, channel_id, slack_ts, limit, max_pages }) => {
      let channelId: SlackChannelId;
      let messageTs: SlackMessageTs;
      let threadTs: SlackMessageTs | undefined;

      if (url) {
        const parsed = parseSlackMessageReference(url);
        if (!parsed.ok) {
          throw new ToolInputError(parsed.error);
        }
        channelId = parsed.reference.channelId;
        messageTs = parsed.reference.messageTs;
        threadTs = parsed.reference.threadTs;
      } else if (slack_ts) {
        const parsedTs = parseRequiredSlackTimestampParam("slack_ts", slack_ts);
        if (!parsedTs.ok) {
          throw new ToolInputError(parsedTs.error);
        }
        // Without a channel, read the current Conversation's channel. The
        // model often has only a timestamp from the current thread.
        channelId = channel_id
          ? (
              await resolveSlackChannelRef({
                field: "channel_id",
                value: channel_id,
                teamId: context.teamId,
              })
            ).channelId
          : context.locationChannelId;
        messageTs = parsedTs.value;
      } else {
        throw new ToolInputError(
          "Provide a Slack message `url` or a `slack_ts`. `channel_id` defaults to the current conversation's channel.",
        );
      }

      const access = await checkSlackChannelReadAccess({
        currentChannelIds: [
          context.destinationChannelId,
          context.locationChannelId,
        ],
        targetChannelId: channelId,
        teamId: context.teamId,
      });
      if (!access.allowed) {
        throw new ToolInputError(access.error);
      }

      const lookupTs = threadTs ?? messageTs;
      const readReplies = async () =>
        listThreadReplies({
          channelId,
          threadTs: lookupTs,
          limit: limit ?? 1000,
          maxPages: max_pages ?? undefined,
        });

      let replies: SlackThreadReply[] | undefined;
      let joined = false;
      let channelName = access.channelName;
      let readError: unknown;
      try {
        replies = await readReplies();
      } catch (error) {
        readError = error;
        const canJoin =
          error instanceof SlackActionError &&
          error.code === "not_in_channel" &&
          access.isMember !== true;
        if (canJoin) {
          const joinResult = await joinPublicChannelForRead({
            channelName,
            targetChannelId: channelId,
          });
          if (!joinResult.ok) {
            throw new ToolInputError(joinResult.error);
          }
          joined = true;
          channelName = joinResult.channelName ?? channelName;
          try {
            replies = await readReplies();
            readError = undefined;
          } catch (retryError) {
            readError = retryError;
          }
        }
      }

      if (!replies) {
        const error = readError;
        if (error instanceof SlackActionError) {
          if (error.code === "not_in_channel") {
            throw new ToolInputError(
              "Could not read this Slack thread because the bot is not in the channel.",
              { cause: error },
            );
          }
          if (error.code === "missing_scope") {
            throw new ToolInputError(
              "Could not read this Slack thread because this installation is missing history scopes.",
              { cause: error },
            );
          }
          throw new ToolInputError("Could not read this Slack thread.", {
            cause: error,
          });
        }
        throw error;
      }

      if (replies.length === 0) {
        throw new ToolInputError("No messages found for this thread.");
      }

      const root = replies[0];
      const resolvedThreadTs =
        threadTs ?? root?.thread_ts ?? root?.ts ?? lookupTs;

      const slackFileIds = replies.flatMap((reply) =>
        collectMessageFiles(reply)
          .map((file) => file.id)
          .filter((fileId): fileId is string => Boolean(fileId)),
      );
      const storedAttachments = attachmentDeps
        ? await matchSlackAttachments({
            conversationId: attachmentDeps.conversationId,
            db: attachmentDeps.db,
            providerIds: slackFileIds,
          })
        : [];
      const attachmentIdsBySlackFileId = new Map(
        storedAttachments.flatMap((attachment) =>
          attachment.providerId
            ? [[attachment.providerId, attachment.id] as const]
            : [],
        ),
      );
      let unstoredFileCount = 0;
      // Only the current Conversation's own thread. Files from other threads
      // stay metadata-only.
      const isCurrentThread =
        channelId === context.locationChannelId &&
        resolvedThreadTs === context.threadTs;
      if (attachmentDeps?.storage && isCurrentThread) {
        // Key by Slack file id, so a file shared twice uses one cap slot.
        const unstored = [
          ...new Map(
            replies.flatMap((reply) =>
              collectMessageFiles(reply)
                .filter(
                  (file) =>
                    file.id &&
                    file.url_private &&
                    isSlackFileUrl(file.url_private) &&
                    !attachmentIdsBySlackFileId.has(file.id),
                )
                .map((file) => [file.id, file] as const),
            ),
          ).values(),
        ];
        // One read stores at most as many files as a Turn gives the model.
        // A later read stores the rest, because stored files match first.
        unstoredFileCount = Math.max(
          0,
          unstored.length - MAX_MODEL_ATTACHMENTS,
        );
        for (const [fileId, attachmentId] of await storeThreadFiles({
          conversationId: attachmentDeps.conversationId,
          db: attachmentDeps.db,
          files: unstored.slice(0, MAX_MODEL_ATTACHMENTS),
          storage: attachmentDeps.storage,
        })) {
          attachmentIdsBySlackFileId.set(fileId, attachmentId);
        }
      }
      const messages = replies.map((reply) =>
        sanitizeMessage(reply, attachmentIdsBySlackFileId),
      );
      const conversationIds = await findThreadConversationIds({
        channelId,
        teamId: context.teamId,
        threadTs: resolvedThreadTs,
      });

      return {
        channel_id: channelId,
        ...(channelName ? { channel_name: channelName } : undefined),
        ...(joined ? { joined_channel: true } : undefined),
        target_message_ts: messageTs,
        thread_ts: resolvedThreadTs,
        ...(conversationIds.length > 0
          ? { conversation_ids: conversationIds }
          : undefined),
        count: messages.length,
        ...(unstoredFileCount > 0
          ? { unstored_file_count: unstoredFileCount }
          : undefined),
        messages,
      };
    },
  });
}
