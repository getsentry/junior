import type { AppMentionEvent, GenericMessageEvent } from "@slack/types";
import { TEST_CHANNEL_ID, TEST_THREAD_TS, TEST_USER_ID } from "./ids";

export interface SlackEventsApiEnvelope {
  token: string;
  team_id: string;
  api_app_id: string;
  type: "event_callback";
  event_id: string;
  event_time: number;
  event: AppMentionEvent | GenericMessageEvent;
}

function deriveChannelType(
  channel: string,
): "channel" | "group" | "im" | undefined {
  if (channel.startsWith("D")) return "im";
  if (channel.startsWith("G")) return "group";
  if (channel.startsWith("C")) return "channel";
  return undefined;
}

/**
 * Raw Slack Events API wrapper fixture for transport-level webhook tests.
 * Keep author-team fields absent, as in Slack's message and mention examples.
 * Docs:
 * - https://docs.slack.dev/apis/events-api/
 * - https://docs.slack.dev/reference/events/app_mention/
 * - https://docs.slack.dev/reference/events/message/
 * - https://docs.slack.dev/reference/events/assistant_thread_started/
 */
export function slackEventsApiEnvelope(
  input: {
    eventType?: "app_mention" | "message";
    user?: string;
    text?: string;
    channel?: string;
    ts?: string;
    eventTs?: string;
    threadTs?: string | undefined;
  } = {},
): SlackEventsApiEnvelope {
  const ts = input.ts ?? TEST_THREAD_TS;
  const channel = input.channel ?? TEST_CHANNEL_ID;
  const event = {
    user: input.user ?? TEST_USER_ID,
    text: input.text ?? "<@U0APP> hello",
    channel,
    ts,
    event_ts: input.eventTs ?? ts,
    ...(input.threadTs ? { thread_ts: input.threadTs } : undefined),
  };

  return {
    token: "test-token",
    team_id: "T123",
    api_app_id: "A_TEST",
    type: "event_callback",
    event_id: "Ev_TEST",
    event_time: 1700000000,
    event:
      input.eventType === "message"
        ? {
            ...event,
            type: "message",
            subtype: undefined,
            channel_type: deriveChannelType(channel) ?? "channel",
          }
        : { ...event, type: "app_mention" },
  };
}
