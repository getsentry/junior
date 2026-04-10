import type { Adapter, Message, WebhookOptions } from "chat";

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

interface SlackMessageChangedEvent {
  type: "event_callback";
  event: {
    type: "message";
    subtype: "message_changed";
    channel: string;
    message: {
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

function isMessageChangedEnvelope(
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
export function textMentionsBot(text: string, botUserId: string): boolean {
  return text.includes(`<@${botUserId}>`);
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

  const raw: Record<string, unknown> = {
    channel: channelId,
    ts: messageTs,
    thread_ts: threadTs,
    user: userId,
  };

  // Build a minimal Message that satisfies the Chat SDK contract.
  // The adapter field is needed by the SDK to resolve the thread.
  const message = {
    id: messageTs,
    threadId,
    text: newText,
    isMention: true,
    attachments: [],
    metadata: { dateSent: new Date(Number(messageTs) * 1000), edited: true },
    formatted: { type: "root" as const, children: [] },
    raw,
    adapter,
    author: {
      userId,
      userName: userId,
      fullName: userId,
      isBot: false,
      isMe: false,
    },
    toJSON() {
      return {} as ReturnType<Message["toJSON"]>;
    },
  } as unknown as Message;

  return { threadId, message };
}

/**
 * Attempt to handle a Slack `message_changed` event that introduces a new bot
 * @mention. Calls `processMessage` on the bot when the event qualifies.
 *
 * This is a side-channel ingress path that runs before the normal Slack adapter
 * webhook handling, which silently drops `message_changed` subtypes.
 *
 * @returns `true` when the event was handled and `processMessage` was called.
 */
export function handleMessageChangedMention(
  body: unknown,
  botUserId: string,
  adapter: Adapter,
  processMessage: (
    adapter: Adapter,
    threadId: string,
    message: Message,
    options?: WebhookOptions,
  ) => void,
  options?: WebhookOptions,
): boolean {
  const result = extractMessageChangedMention(body, botUserId, adapter);
  if (!result) return false;

  processMessage(adapter, result.threadId, result.message, options);
  return true;
}
