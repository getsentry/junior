import type { SlackAdapter, SlackEvent } from "@chat-adapter/slack";
import type { JuniorChat } from "@/chat/ingress/junior-chat";
import type { WebhookOptions } from "chat";
import { logInfo, logWarn } from "@/chat/logging";

/**
 * Raw shape of a Slack `message_changed` event payload.
 *
 * Slack delivers edits as `event_callback` envelopes with
 * `event.subtype === "message_changed"`. The adapter ignores these, so
 * we handle them here before the adapter sees the request.
 *
 * Reference: https://docs.slack.dev/reference/events/message/message_changed
 */
interface SlackMessageChangedEvent {
  type: "message";
  subtype: "message_changed";
  channel: string;
  channel_type?: string;
  ts: string;
  message: {
    type: string;
    user?: string;
    text?: string;
    ts: string;
    thread_ts?: string;
    edited?: { ts: string; user: string };
    bot_id?: string;
  };
  previous_message?: {
    text?: string;
  };
}

interface SlackEventCallbackPayload {
  type: "event_callback";
  team_id?: string;
  event?: Record<string, unknown>;
}

/**
 * Check whether the edited message text newly introduces a bot mention
 * that was absent in the previous message text.
 */
function isNewBotMention(
  newText: string | undefined,
  previousText: string | undefined,
  botUserId: string,
): boolean {
  const mention = `<@${botUserId}>`;
  const inNew = (newText ?? "").includes(mention);
  const inPrev = (previousText ?? "").includes(mention);
  return inNew && !inPrev;
}

/**
 * Synthesize an `app_mention`-like Slack event from a `message_changed`
 * inner message so that the bot's existing mention handler can process it.
 */
function synthesizeMentionEvent(
  changed: SlackMessageChangedEvent,
  teamId: string | undefined,
): SlackEvent {
  const msg = changed.message;
  return {
    type: "app_mention",
    user: msg.user,
    text: msg.text ?? "",
    channel: changed.channel,
    channel_type: changed.channel_type,
    ts: msg.ts,
    thread_ts: msg.thread_ts ?? msg.ts,
    team_id: teamId,
    edited: msg.edited,
  };
}

/**
 * Attempt to dispatch a `message_changed` Slack event as a bot mention.
 *
 * Returns `true` when the payload contained a qualifying edit (i.e., a
 * `message_changed` event that newly adds a bot @mention) and dispatched
 * it to the Chat runtime. Returns `false` for all other payloads so the
 * caller can continue with normal adapter processing.
 *
 * Called from `handlers/webhooks.ts` before the request body is consumed
 * by the adapter's `handleWebhook`.
 */
export function dispatchMessageChangedMention(
  payload: unknown,
  bot: JuniorChat<{ slack: SlackAdapter }>,
  options: WebhookOptions,
): boolean {
  if (
    !payload ||
    typeof payload !== "object" ||
    (payload as SlackEventCallbackPayload).type !== "event_callback"
  ) {
    return false;
  }

  const envelope = payload as SlackEventCallbackPayload;
  const event = envelope.event;
  if (
    !event ||
    event["type"] !== "message" ||
    event["subtype"] !== "message_changed"
  ) {
    return false;
  }

  const changed = event as unknown as SlackMessageChangedEvent;
  const msg = changed.message;
  if (!msg || msg.bot_id) {
    // Skip bot-authored edits.
    return false;
  }

  const adapter = bot.getAdapter("slack");
  const botUserId = adapter.botUserId;
  if (!botUserId) {
    logWarn(
      "message_changed_no_bot_user_id",
      {},
      {
        "app.event.channel": changed.channel,
        "app.event.ts": changed.ts,
      },
    );
    return false;
  }

  if (!isNewBotMention(msg.text, changed.previous_message?.text, botUserId)) {
    return false;
  }

  logInfo(
    "message_changed_mention_dispatched",
    {},
    {
      "app.event.channel": changed.channel,
      "app.event.ts": changed.ts,
      "app.event.message_ts": msg.ts,
      "app.event.thread_ts": msg.thread_ts ?? msg.ts,
    },
  );

  const synthesized = synthesizeMentionEvent(changed, envelope.team_id);
  const rawMsg = adapter.parseMessage(synthesized);
  rawMsg.isMention = true;

  const channel = changed.channel;
  const threadTs = msg.thread_ts ?? msg.ts;
  const threadId = `slack:${channel}:${threadTs}`;

  bot.processMessage(adapter, threadId, rawMsg, options);
  return true;
}
