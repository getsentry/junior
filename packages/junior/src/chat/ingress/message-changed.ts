import type { SlackEvent } from "@chat-adapter/slack";

interface SlackMessageChangedEvent {
  channel: string;
  channel_type?: string;
  message: {
    bot_id?: string;
    edited?: { ts: string; user: string };
    text?: string;
    thread_ts?: string;
    ts: string;
    user?: string;
  };
  previous_message?: {
    text?: string;
  };
  subtype: "message_changed";
  type: "message";
}

interface SlackEventCallbackPayload {
  event?: Record<string, unknown>;
  team_id?: string;
  type: "event_callback";
}

export interface MessageChangedMentionDispatch {
  event: SlackEvent;
  threadId: string;
}

function hasNewBotMention(
  newText: string | undefined,
  previousText: string | undefined,
  botUserId: string,
): boolean {
  const mention = `<@${botUserId}>`;
  return (
    (newText ?? "").includes(mention) && !(previousText ?? "").includes(mention)
  );
}

/**
 * Build the parsed Slack message input for an edited message that newly adds a bot mention.
 */
export function buildMessageChangedMentionDispatch(
  payload: unknown,
  botUserId: string | undefined,
): MessageChangedMentionDispatch | undefined {
  if (
    !botUserId ||
    !payload ||
    typeof payload !== "object" ||
    (payload as SlackEventCallbackPayload).type !== "event_callback"
  ) {
    return undefined;
  }

  const envelope = payload as SlackEventCallbackPayload;
  const event = envelope.event;
  if (
    !event ||
    event["type"] !== "message" ||
    event["subtype"] !== "message_changed"
  ) {
    return undefined;
  }

  const changed = event as unknown as SlackMessageChangedEvent;
  const message = changed.message;
  if (
    !message ||
    !message.user ||
    message.bot_id ||
    message.user === botUserId ||
    !hasNewBotMention(message.text, changed.previous_message?.text, botUserId)
  ) {
    return undefined;
  }

  const threadTs = message.thread_ts ?? message.ts;
  return {
    event: {
      type: "message",
      user: message.user,
      text: message.text ?? "",
      channel: changed.channel,
      channel_type: changed.channel_type,
      ts: message.ts,
      thread_ts: threadTs,
      team_id: envelope.team_id,
      edited: message.edited,
    },
    threadId: `slack:${changed.channel}:${threadTs}`,
  };
}
