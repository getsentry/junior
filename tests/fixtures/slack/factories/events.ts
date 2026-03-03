import { TEST_CHANNEL_ID, TEST_THREAD_TS, TEST_USER_ID, slackThreadId } from "./ids";

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
    thread_ts?: string;
  };
}

export function slackEventsApiEnvelope(input: {
  eventType?: "app_mention" | "message";
  user?: string;
  text?: string;
  channel?: string;
  ts?: string;
  threadTs?: string;
} = {}): SlackEventsApiEnvelope {
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
      channel: input.channel ?? TEST_CHANNEL_ID,
      ts: input.ts ?? TEST_THREAD_TS,
      ...(input.threadTs ? { thread_ts: input.threadTs } : {})
    }
  };
}
