import path from "node:path";
import type { Message } from "chat";
import type { AppRuntimeAssistantLifecycleEvent } from "@/chat/app-runtime";
import { appSlackRuntime, bot, resetBotDepsForTests, setBotDepsForTests } from "@/chat/bot";
import { generateAssistantReply } from "@/chat/respond";
import { FakeSlackAdapter, createTestThread, type TestThread } from "../tests/fixtures/slack-harness";

interface BehaviorEventThreadFixture {
  channel_id?: string;
  id: string;
  run_id?: string;
  thread_ts?: string;
}

interface BehaviorEventMessageFixture {
  author?: {
    full_name?: string;
    is_bot?: boolean;
    is_me?: boolean;
    user_id?: string;
    user_name?: string;
  };
  id?: string;
  is_mention?: boolean;
  text?: string;
}

interface BehaviorBaseEvent {
  thread: BehaviorEventThreadFixture;
}

interface MentionEvent extends BehaviorBaseEvent {
  message: BehaviorEventMessageFixture;
  type: "new_mention";
}

interface SubscribedMessageEvent extends BehaviorBaseEvent {
  message: BehaviorEventMessageFixture;
  type: "subscribed_message";
}

interface AssistantThreadStartedEvent extends BehaviorBaseEvent {
  type: "assistant_thread_started";
  user_id?: string;
}

interface AssistantContextChangedEvent extends BehaviorBaseEvent {
  type: "assistant_context_changed";
  user_id?: string;
}

export type BehaviorCaseEvent =
  | MentionEvent
  | SubscribedMessageEvent
  | AssistantThreadStartedEvent
  | AssistantContextChangedEvent;

interface SubscribedDecisionFixture {
  reason: string;
  should_reply: boolean;
}

export interface BehaviorCaseConfig {
  enable_test_credentials?: boolean;
  fail_reply_call?: number;
  mock_slack_api?: boolean;
  skill_dirs?: string[];
  test_credential_token?: string;
  unset_gateway_api_key?: boolean;
  reply_texts?: string[];
  subscribed_decisions?: SubscribedDecisionFixture[];
}

export interface BehaviorEvalCase {
  behavior?: BehaviorCaseConfig;
  events: BehaviorCaseEvent[];
}

export interface BehaviorCaseResult {
  channelPosts: Array<{
    channel: string;
    text: string;
    thread_ts?: string;
  }>;
  reactions: Array<{
    channel: string;
    emoji: string;
    timestamp: string;
  }>;
  posts: string[];
  slackAdapter: FakeSlackAdapter;
}

function toPostedText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    const markdown = (value as { markdown?: unknown }).markdown;
    if (typeof markdown === "string") {
      return markdown;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return "[unserializable post payload]";
    }
  }
  return String(value);
}

function toIncomingMessage(event: MentionEvent | SubscribedMessageEvent) {
  const messageTs = event.thread.thread_ts ?? event.message.id;
  return {
    id: event.message.id ?? "",
    text: event.message.text ?? "",
    isMention: event.message.is_mention,
    attachments: [],
    metadata: { dateSent: new Date(), edited: false },
    channelId: event.thread.channel_id,
    threadId: event.thread.id,
    threadTs: event.thread.thread_ts,
    runId: event.thread.run_id,
    raw: {
      channel: event.thread.channel_id,
      ts: messageTs,
      thread_ts: event.thread.thread_ts
    },
    author: {
      userId: event.message.author?.user_id ?? "",
      userName: event.message.author?.user_name ?? "",
      fullName: event.message.author?.full_name ?? "",
      isMe: event.message.author?.is_me ?? false,
      isBot: event.message.author?.is_bot ?? false
    }
  };
}

export async function runBehaviorEvalCase(testCase: BehaviorEvalCase): Promise<BehaviorCaseResult> {
  const slackAdapter = new FakeSlackAdapter();
  const channelPosts: Array<{
    channel: string;
    text: string;
    thread_ts?: string;
  }> = [];
  const reactions: Array<{
    channel: string;
    emoji: string;
    timestamp: string;
  }> = [];
  const threadsById = new Map<string, TestThread>();
  const channelStateById = new Map<string, { value: Record<string, unknown> }>();
  const replyTexts = testCase.behavior?.reply_texts ?? [];
  const subscribedDecisions = testCase.behavior?.subscribed_decisions ?? [];
  const replyTimeoutMs = Number.parseInt(process.env.EVAL_AGENT_REPLY_TIMEOUT_MS ?? "45000", 10);
  let replyCallCount = 0;
  let decisionIndex = 0;
  const originalEnableTestCredentials = process.env.EVAL_ENABLE_TEST_CREDENTIALS;
  const originalTestCredentialToken = process.env.EVAL_TEST_CREDENTIAL_TOKEN;
  const originalSlackBotToken = process.env.SLACK_BOT_TOKEN;
  const originalFetch = globalThis.fetch;
  const configuredSkillDirs =
    testCase.behavior?.skill_dirs?.map((entry) => path.resolve(process.cwd(), entry)) ?? [];
  if (testCase.behavior?.enable_test_credentials) {
    process.env.EVAL_ENABLE_TEST_CREDENTIALS = "1";
    if (testCase.behavior?.test_credential_token) {
      process.env.EVAL_TEST_CREDENTIAL_TOKEN = testCase.behavior.test_credential_token;
    }
  }
  if (testCase.behavior?.mock_slack_api) {
    process.env.SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? "xoxb-eval-test-token";
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.startsWith("https://slack.com/api/")) {
        return originalFetch(input, init);
      }

      const endpoint = new URL(url).pathname.split("/").at(-1) ?? "";
      const body = init?.body;
      let payload: Record<string, unknown> = {};
      if (typeof body === "string") {
        payload = Object.fromEntries(new URLSearchParams(body).entries());
      } else if (body instanceof URLSearchParams) {
        payload = Object.fromEntries(body.entries());
      }

      if (endpoint === "chat.postMessage") {
        const channel = typeof payload.channel === "string" ? payload.channel : "C_EVAL";
        const text = typeof payload.text === "string" ? payload.text : "";
        const threadTs = typeof payload.thread_ts === "string" ? payload.thread_ts : undefined;
        channelPosts.push({
          channel,
          text,
          ...(threadTs ? { thread_ts: threadTs } : {})
        });
        return new Response(
          JSON.stringify({
            ok: true,
            channel,
            ts: "17000000.channel-post",
            ...(threadTs ? { thread_ts: threadTs } : {})
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }

      if (endpoint === "reactions.add") {
        const channel = typeof payload.channel === "string" ? payload.channel : "C_EVAL";
        const emoji = typeof payload.name === "string" ? payload.name : "";
        const timestamp = typeof payload.timestamp === "string" ? payload.timestamp : "";
        reactions.push({
          channel,
          emoji,
          timestamp
        });
        return new Response(
          JSON.stringify({
            ok: true
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }

      if (endpoint === "chat.getPermalink") {
        const channel = typeof payload.channel === "string" ? payload.channel : "C_EVAL";
        const messageTs = typeof payload.message_ts === "string" ? payload.message_ts : "17000000.channel-post";
        return new Response(
          JSON.stringify({
            ok: true,
            channel,
            permalink: `https://slack.example.com/archives/${channel}/p${messageTs.replace(".", "")}`
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;
  }

  const getChannelStateRef = (channelId: string | undefined): { value: Record<string, unknown> } | undefined => {
    const normalized = channelId?.trim();
    if (!normalized) return undefined;
    const existing = channelStateById.get(normalized);
    if (existing) return existing;
    const created = { value: {} };
    channelStateById.set(normalized, created);
    return created;
  };

  const getThread = (fixture: BehaviorEventThreadFixture): TestThread => {
    const existing = threadsById.get(fixture.id);
    if (existing) {
      return existing;
    }
    const created = createTestThread({
      id: fixture.id,
      channelId: fixture.channel_id,
      runId: fixture.run_id,
      threadTs: fixture.thread_ts,
      channelStateRef: getChannelStateRef(fixture.channel_id)
    });
    threadsById.set(fixture.id, created);
    return created;
  };

  const originalGetAdapter = (bot as unknown as { getAdapter?: (name: string) => unknown }).getAdapter?.bind(bot);
  (bot as unknown as { getAdapter: (name: string) => unknown }).getAdapter = (name: string): unknown => {
    if (name === "slack") {
      return slackAdapter;
    }
    return originalGetAdapter ? originalGetAdapter(name) : undefined;
  };

  setBotDepsForTests({
    completeObject: async () => {
      if (subscribedDecisions.length === 0) {
        return {
          object: { should_reply: false, confidence: 0, reason: "passive conversation" },
          text: "{\"should_reply\":false,\"confidence\":0,\"reason\":\"passive conversation\"}"
        } as any;
      }
      const next = subscribedDecisions[Math.min(decisionIndex, subscribedDecisions.length - 1)];
      decisionIndex += 1;
      return {
        object: {
          should_reply: next.should_reply,
          confidence: next.should_reply ? 1 : 0,
          reason: next.reason
        },
        text: JSON.stringify({
          should_reply: next.should_reply,
          confidence: next.should_reply ? 1 : 0,
          reason: next.reason
        })
      } as any;
    },
    generateAssistantReply: async (text, context) => {
      replyCallCount += 1;
      if (testCase.behavior?.fail_reply_call === replyCallCount) {
        throw new Error(`forced reply failure on call ${replyCallCount}`);
      }

      const originalGatewayApiKey = process.env.AI_GATEWAY_API_KEY;
      const originalOidcToken = process.env.VERCEL_OIDC_TOKEN;
      if (testCase.behavior?.unset_gateway_api_key) {
        delete process.env.AI_GATEWAY_API_KEY;
        delete process.env.VERCEL_OIDC_TOKEN;
      }
      let reply: Awaited<ReturnType<typeof generateAssistantReply>>;
      try {
        reply = await Promise.race([
          generateAssistantReply(text, {
            ...context,
            ...(configuredSkillDirs.length > 0 ? { skillDirs: configuredSkillDirs } : {})
          }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`generateAssistantReply timed out after ${replyTimeoutMs}ms`)),
              replyTimeoutMs
            )
          )
        ]);
      } finally {
        if (testCase.behavior?.unset_gateway_api_key) {
          if (originalGatewayApiKey === undefined) {
            delete process.env.AI_GATEWAY_API_KEY;
          } else {
            process.env.AI_GATEWAY_API_KEY = originalGatewayApiKey;
          }
          if (originalOidcToken === undefined) {
            delete process.env.VERCEL_OIDC_TOKEN;
          } else {
            process.env.VERCEL_OIDC_TOKEN = originalOidcToken;
          }
        }
      }

      const replyText = replyTexts[replyCallCount - 1];
      if (typeof replyText === "string") {
        return {
          ...reply,
          text: replyText
        };
      }
      return reply;
    }
  });

  try {
    for (const event of testCase.events) {
      if (event.type === "new_mention") {
        const thread = getThread(event.thread);
        await appSlackRuntime.handleNewMention(thread, toIncomingMessage(event) as any);
        continue;
      }

      if (event.type === "subscribed_message") {
        const thread = getThread(event.thread);
        await appSlackRuntime.handleSubscribedMessage(thread, toIncomingMessage(event) as any);
        continue;
      }

      const lifecycleEvent: AppRuntimeAssistantLifecycleEvent = {
        threadId: event.thread.id,
        channelId: event.thread.channel_id ?? "C_EVAL",
        threadTs: event.thread.thread_ts ?? "0",
        userId: event.user_id
      };
      if (event.type === "assistant_thread_started") {
        await appSlackRuntime.handleAssistantThreadStarted(lifecycleEvent);
        continue;
      }

      await appSlackRuntime.handleAssistantContextChanged(lifecycleEvent);
    }
  } finally {
    resetBotDepsForTests();
    (bot as unknown as { getAdapter?: (name: string) => unknown }).getAdapter = originalGetAdapter;
    globalThis.fetch = originalFetch;
    if (originalSlackBotToken === undefined) {
      delete process.env.SLACK_BOT_TOKEN;
    } else {
      process.env.SLACK_BOT_TOKEN = originalSlackBotToken;
    }
    if (testCase.behavior?.enable_test_credentials) {
      if (originalEnableTestCredentials === undefined) {
        delete process.env.EVAL_ENABLE_TEST_CREDENTIALS;
      } else {
        process.env.EVAL_ENABLE_TEST_CREDENTIALS = originalEnableTestCredentials;
      }
      if (originalTestCredentialToken === undefined) {
        delete process.env.EVAL_TEST_CREDENTIAL_TOKEN;
      } else {
        process.env.EVAL_TEST_CREDENTIAL_TOKEN = originalTestCredentialToken;
      }
    }
  }

  const posts = [...threadsById.values()].flatMap((thread) => thread.posts.map(toPostedText));

  return {
    channelPosts,
    reactions,
    posts,
    slackAdapter
  };
}

// Compile-time guards for Thread and Message fakes are in tests/fixtures/slack-harness.ts.
// The toIncomingMessage function below still needs a local check since it maps from eval-specific fixtures.
type AssertAssignable<_TSub extends TSuper, TSuper> = true;
type _MessageCheck = AssertAssignable<ReturnType<typeof toIncomingMessage>, Pick<Message, "id" | "text" | "isMention" | "attachments" | "metadata" | "author">>;
