import {
  storeAttachment,
  type StoredAttachment,
} from "@/chat/attachments/store";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import { matchSlackAttachments } from "@/chat/slack/attachments";
import { listThreadReplies } from "@/chat/slack/channel";
import { downloadPrivateSlackFile } from "@/chat/slack/client";
import type { SlackChannelId } from "@/chat/slack/ids";
import { collectMessageFiles } from "@/chat/slack/message/attachments";
import type { SlackMessageTs } from "@/chat/slack/timestamp";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { JuniorSqlDatabase } from "@/db/db";

// Stored attachment ids are lowercase hex, so this never matches one.
const SLACK_FILE_ID_PATTERN = /^F[A-Z0-9]+$/;

/** Private file URLs get the bot token, so send it only to Slack hosts. */
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
 * Store a file of the Conversation's own Slack thread, found by its Slack
 * file id.
 *
 * A Turn stores only the files of the messages it reads at its start, so a
 * thread can show files that no Turn stored: a root post that an Automation
 * run started on, a file under a linked or forwarded message, or a message
 * that started no Turn. A stored file matches first and is not downloaded
 * again. Other files must be in this thread, so a Conversation never stores a
 * file from a thread that it does not belong to. Returns `undefined` when the
 * id is not a Slack file id.
 */
export async function storeSlackThreadFile(args: {
  channelId: SlackChannelId;
  conversationId: string;
  db: JuniorSqlDatabase;
  fileId: string;
  storage: AttachmentStorage;
  threadTs: SlackMessageTs;
}): Promise<StoredAttachment | undefined> {
  if (!SLACK_FILE_ID_PATTERN.test(args.fileId)) return undefined;
  const [stored] = await matchSlackAttachments({
    conversationId: args.conversationId,
    db: args.db,
    providerIds: [args.fileId],
  });
  if (stored) return { id: stored.id };

  const replies = await listThreadReplies({
    channelId: args.channelId,
    threadTs: args.threadTs,
  });
  const file = replies
    .flatMap((reply) => collectMessageFiles(reply))
    .find((candidate) => candidate.id === args.fileId);
  const url = file?.url_private_download ?? file?.url_private;
  if (!file || !url || !isSlackFileUrl(url)) {
    throw new ToolInputError(
      `Slack file ${args.fileId} is not in this conversation's thread.`,
    );
  }
  const data = await downloadPrivateSlackFile(url);
  const filename = file.name ?? "attachment";
  return await storeAttachment({
    conversationId: args.conversationId,
    db: args.db,
    file: {
      bytes: data.byteLength,
      data,
      filename,
      mimeType: file.mimetype ?? "application/octet-stream",
      path: filename,
    },
    source: { id: args.fileId, provider: "slack" },
    storage: args.storage,
  });
}
