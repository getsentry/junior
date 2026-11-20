import type { AttachmentStorage } from "@/chat/attachments/storage";
import type { JuniorSqlDatabase } from "@/db/db";
import { isConversationDeliveryPaused } from "@/chat/conversations/delivery-pause";
import { uploadFilesToConversation } from "@/chat/slack/outbound";
import type { SlackToolContext } from "@/chat/slack/tool-support/context";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import {
  createSendFilesTool,
  type MaterializeFile,
} from "@/chat/tools/send-files";
import type { ToolState } from "@/chat/tools/types";

/**
 * Deliver files to the active Slack Location and retain Conversation
 * attachments. While the Conversation is detached from Slack, files are only
 * retained.
 */
export function createSlackSendFilesTool(
  context: SlackToolContext,
  state: ToolState,
  materializeFile: MaterializeFile,
  conversationId: string,
  attachments?: {
    db: JuniorSqlDatabase;
    storage: AttachmentStorage;
  },
) {
  const channelId = context.locationChannelId;
  const threadTs = context.threadTs ?? context.messageTs;
  return createSendFilesTool(state, materializeFile, {
    ...(attachments
      ? { attachments: { ...attachments, conversationId } }
      : undefined),
    delivery: {
      key: `${channelId}:${threadTs ?? ""}`,
      description:
        "Send one or more sandbox files into the active Slack conversation.",
      async send(files) {
        // Read the pause at send time: a person can detach while this Turn
        // runs.
        if (await isConversationDeliveryPaused(conversationId)) {
          if (!attachments) {
            throw new ToolInputError(
              "This conversation is detached from Slack, so files cannot be sent to it.",
            );
          }
          return;
        }
        await uploadFilesToConversation({
          channelId,
          files: files.map((file) => ({
            data: file.data,
            filename: file.filename,
          })),
          ...(threadTs ? { threadTs } : undefined),
        });
      },
    },
  });
}
