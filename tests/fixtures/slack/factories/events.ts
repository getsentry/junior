import { TEST_CHANNEL_ID, TEST_THREAD_TS, TEST_USER_ID, slackThreadId } from "./ids";

/**
 * Behavior-event fixtures model the normalized Chat SDK handler payload shape used by
 * app runtime tests, not raw Slack Events API envelopes.
 * Docs:
 * - https://chat-sdk.dev/docs/reference/chat/on-new-mention
 * - https://chat-sdk.dev/docs/reference/chat/on-subscribed-message
 * - https://chat-sdk.dev/docs/reference/core/message
 */
export interface SlackEventUser {
  user_id: string;
  user_name: string;
  full_name: string;
  is_me: boolean;
  is_bot: boolean;
}

export interface SlackEventMessageFixture {
  id: string;
  text: string;
  is_mention: boolean;
  author: SlackEventUser;
}

export interface SlackEventThreadFixture {
  id: string;
  channel_id: string;
  thread_ts: string;
}

export interface SlackMentionBehaviorEventFixture {
  type: "new_mention";
  thread: SlackEventThreadFixture;
  message: SlackEventMessageFixture;
}

export interface SlackSubscribedMessageBehaviorEventFixture {
  type: "subscribed_message";
  thread: SlackEventThreadFixture;
  message: SlackEventMessageFixture;
}

export interface SlackAssistantThreadStartedBehaviorEventFixture {
  type: "assistant_thread_started";
  thread: SlackEventThreadFixture;
  user_id: string;
}

export interface SlackAssistantContextChangedBehaviorEventFixture {
  type: "assistant_context_changed";
  thread: SlackEventThreadFixture;
  user_id: string;
}

export type SlackBehaviorEventFixture =
  | SlackMentionBehaviorEventFixture
  | SlackSubscribedMessageBehaviorEventFixture
  | SlackAssistantThreadStartedBehaviorEventFixture
  | SlackAssistantContextChangedBehaviorEventFixture;

const DEFAULT_AUTHOR: SlackEventUser = {
  user_id: TEST_USER_ID,
  user_name: "testuser",
  full_name: "Test User",
  is_me: false,
  is_bot: false
};

export function slackEventThread(input: Partial<SlackEventThreadFixture> = {}): SlackEventThreadFixture {
  const channelId = input.channel_id ?? TEST_CHANNEL_ID;
  const threadTs = input.thread_ts ?? TEST_THREAD_TS;
  return {
    id: input.id ?? slackThreadId(channelId, threadTs),
    channel_id: channelId,
    thread_ts: threadTs
  };
}

export function slackEventMessage(input: Partial<SlackEventMessageFixture> = {}): SlackEventMessageFixture {
  return {
    id: input.id ?? "m-test",
    text: input.text ?? "hello",
    is_mention: input.is_mention ?? false,
    author: {
      ...DEFAULT_AUTHOR,
      ...(input.author ?? {})
    }
  };
}

// Normalized explicit-mention behavior fixture.
// Chat SDK contract: https://chat-sdk.dev/docs/reference/chat/on-new-mention
export function slackMentionEvent(input: {
  thread?: Partial<SlackEventThreadFixture>;
  message?: Partial<SlackEventMessageFixture>;
} = {}): SlackMentionBehaviorEventFixture {
  return {
    type: "new_mention",
    thread: slackEventThread(input.thread),
    message: slackEventMessage({ ...input.message, is_mention: true })
  };
}

// Normalized "non-mention message in subscribed thread" behavior fixture.
// Chat SDK contract: https://chat-sdk.dev/docs/reference/chat/on-subscribed-message
export function slackSubscribedMessageEvent(input: {
  thread?: Partial<SlackEventThreadFixture>;
  message?: Partial<SlackEventMessageFixture>;
} = {}): SlackSubscribedMessageBehaviorEventFixture {
  return {
    type: "subscribed_message",
    thread: slackEventThread(input.thread),
    message: slackEventMessage({ ...input.message, is_mention: input.message?.is_mention ?? false })
  };
}

// Slack assistant lifecycle callback fixture.
// Slack event reference: https://docs.slack.dev/reference/events/assistant_thread_started/
export function slackAssistantThreadStartedEvent(input: {
  thread?: Partial<SlackEventThreadFixture>;
  user_id?: string;
} = {}): SlackAssistantThreadStartedBehaviorEventFixture {
  return {
    type: "assistant_thread_started",
    thread: slackEventThread(input.thread),
    user_id: input.user_id ?? TEST_USER_ID
  };
}

// Slack assistant context callback fixture.
// Slack event reference: https://docs.slack.dev/reference/events/assistant_thread_context_changed/
export function slackAssistantContextChangedEvent(input: {
  thread?: Partial<SlackEventThreadFixture>;
  user_id?: string;
} = {}): SlackAssistantContextChangedBehaviorEventFixture {
  return {
    type: "assistant_context_changed",
    thread: slackEventThread(input.thread),
    user_id: input.user_id ?? TEST_USER_ID
  };
}

export interface SlackEventsApiEnvelope {
  token: string;
  team_id: string;
  api_app_id: string;
  type: "event_callback";
  event_id: string;
  event_time: number;
  event: {
    type: "app_mention" | "message";
    user: string;
    text: string;
    channel: string;
    ts: string;
    event_ts: string;
    channel_type?: "channel" | "group" | "im" | "mpim";
    thread_ts?: string;
  };
}

/**
 * Raw Slack Events API wrapper fixture for transport-level webhook tests.
 * Docs:
 * - https://docs.slack.dev/apis/events-api/
 * - https://docs.slack.dev/reference/events/app_mention/
 * - https://docs.slack.dev/reference/events/message.im/
 * - https://docs.slack.dev/reference/events/assistant_thread_started/
 */
export function slackEventsApiEnvelope(input: {
  eventType?: "app_mention" | "message";
  user?: string;
  text?: string;
  channel?: string;
  ts?: string;
  eventTs?: string;
  threadTs?: string;
} = {}): SlackEventsApiEnvelope {
  const ts = input.ts ?? TEST_THREAD_TS;
  const channel = input.channel ?? TEST_CHANNEL_ID;
  const channelType = channel.startsWith("D")
    ? "im"
    : channel.startsWith("G")
      ? "group"
      : channel.startsWith("C")
        ? "channel"
        : undefined;

  return {
    token: "test-token",
    team_id: "T_TEST",
    api_app_id: "A_TEST",
    type: "event_callback",
    event_id: "Ev_TEST",
    event_time: 1700000000,
    event: {
      type: input.eventType ?? "app_mention",
      user: input.user ?? TEST_USER_ID,
      text: input.text ?? "<@U_APP> hello",
      channel,
      ts,
      event_ts: input.eventTs ?? ts,
      ...(channelType ? { channel_type: channelType } : {}),
      ...(input.threadTs ? { thread_ts: input.threadTs } : {})
    }
  };
}
