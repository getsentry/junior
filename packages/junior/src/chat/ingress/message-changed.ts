import { Message, type Adapter, type Attachment } from "chat";

/**
 * Parsed result from a Slack `message_changed` event that contains a newly
 * added bot @mention. Returns `null` when the event does not qualify.
 */
export interface MessageChangedMention {
  /** Slack thread ID in `slack:<channel>:<thread_ts>` format. */
  threadId: string;
  /** Synthesized Message to pass to `bot.processMessage`. */
  message: Message;
}

function getEditedMentionMessageId(messageTs: string): string {
  return `${messageTs}:message_changed_mention`;
}

interface SlackMessageChangedEvent {
  type: "event_callback";
  team_id?: string;
  event: {
    type: "message";
    subtype: "message_changed";
    channel: string;
    message: {
      files?: SlackEditedMessageFile[];
      text?: string;
      ts: string;
      thread_ts?: string;
      user?: string;
    };
    previous_message: {
      text?: string;
    };
  };
}

interface SlackEditedMessageFile {
  mimetype?: string;
  name?: string;
  original_h?: number;
  original_w?: number;
  size?: number;
  url_private?: string;
  url_private_download?: string;
}

export function isMessageChangedEnvelope(
  value: unknown,
): value is SlackMessageChangedEvent {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.type !== "event_callback") return false;
  const event = v.event as Record<string, unknown> | undefined;
  if (!event || typeof event !== "object") return false;
  return (
    event.type === "message" &&
    event.subtype === "message_changed" &&
    typeof event.channel === "string" &&
    typeof event.message === "object" &&
    event.message !== null &&
    typeof event.previous_message === "object" &&
    event.previous_message !== null
  );
}

/**
 * Return true if `text` contains a Slack user mention token for `botUserId`.
 *
 * Slack encodes @mentions as `<@UXXXXXXXX>` in message text.
 */
function textMentionsBot(text: string, botUserId: string): boolean {
  return text.includes(`<@${botUserId}>`);
}

function getAttachmentType(mimeType: string | undefined): Attachment["type"] {
  if (mimeType?.startsWith("image/")) {
    return "image";
  }
  if (mimeType?.startsWith("video/")) {
    return "video";
  }
  if (mimeType?.startsWith("audio/")) {
    return "audio";
  }
  return "file";
}

function extractEditedMessageAttachments(
  files: SlackEditedMessageFile[] | undefined,
): Attachment[] {
  if (!files || files.length === 0) {
    return [];
  }

  return files.map((file) => ({
    type: getAttachmentType(file.mimetype),
    url: file.url_private_download ?? file.url_private,
    name: file.name,
    mimeType: file.mimetype,
    size: file.size,
    width: file.original_w,
    height: file.original_h,
  }));
}

/**
 * Inspect a raw parsed Slack webhook body and extract a synthesized mention
 * event when a `message_changed` edit newly adds the bot's @mention.
 *
 * Returns `null` when the payload is not a qualifying `message_changed` event.
 */
export function extractMessageChangedMention(
  body: unknown,
  botUserId: string,
  adapter: Adapter,
): MessageChangedMention | null {
  if (!isMessageChangedEnvelope(body)) return null;

  const { event } = body;
  const newText = event.message.text ?? "";
  const prevText = event.previous_message.text ?? "";

  // Only trigger when the bot mention is newly present in the edited message.
  if (!textMentionsBot(newText, botUserId)) return null;
  if (textMentionsBot(prevText, botUserId)) return null;

  const channelId = event.channel;
  const messageTs = event.message.ts;
  const threadTs = event.message.thread_ts ?? messageTs;
  const userId = event.message.user ?? "unknown";
  const threadId = `slack:${channelId}:${threadTs}`;
  const teamId = typeof body.team_id === "string" ? body.team_id : undefined;

  const raw: Record<string, unknown> = {
    channel: channelId,
    ts: messageTs,
    thread_ts: threadTs,
    user: userId,
    ...(teamId ? { team_id: teamId } : {}),
  };

  const message = new Message({
    id: getEditedMentionMessageId(messageTs),
    threadId,
    text: newText,
    isMention: true,
    attachments: extractEditedMessageAttachments(event.message.files),
    metadata: { dateSent: new Date(Number(messageTs) * 1000), edited: true },
    formatted: { type: "root" as const, children: [] },
    raw,
    author: {
      userId,
      userName: userId,
      fullName: userId,
      isBot: false,
      isMe: false,
    },
  });

  Object.defineProperty(message, "adapter", {
    configurable: true,
    enumerable: false,
    value: adapter,
    writable: true,
  });

  return { threadId, message };
}
