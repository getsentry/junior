import type { AttachmentStorage } from "@/chat/attachments/storage";
import type { JuniorSqlDatabase } from "@/db/db";
import { uploadFilesToConversation } from "@/chat/slack/outbound";
import type { SlackToolContext } from "@/chat/slack/tool-support/context";
import {
  createSendFilesTool,
  type MaterializeFile,
} from "@/chat/tools/send-files";
import type { ToolState } from "@/chat/tools/types";

/** Deliver files to the active Slack Location and retain Conversation attachments. */
export function createSlackSendFilesTool(
  context: SlackToolContext,
  state: ToolState,
  materializeFile: MaterializeFile,
  attachments?: {
    conversationId: string;
    db: JuniorSqlDatabase;
    storage: AttachmentStorage;
  },
) {
  const channelId = context.locationChannelId;
  const threadTs = context.threadTs ?? context.messageTs;
  return createSendFilesTool(state, materializeFile, attachments, {
    key: `${channelId}:${threadTs ?? ""}`,
    description:
      "Send one or more sandbox files into the active Slack conversation.",
    async send(files) {
      await uploadFilesToConversation({
        channelId,
        files: files.map((file) => ({
          data: file.data,
          filename: file.filename,
        })),
        ...(threadTs ? { threadTs } : undefined),
      });
    },
  });
}
