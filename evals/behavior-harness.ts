import path from "node:path";
import type { Message, Thread } from "chat";
import type { AppRuntimeAssistantLifecycleEvent } from "@/chat/app-runtime";
import { parseSlackThreadId } from "@/chat/slack-context";
import { appSlackRuntime, bot, resetBotDepsForTests, setBotDepsForTests } from "@/chat/bot";
import { generateAssistantReply } from "@/chat/respond";
import { resetSkillDiscoveryCache } from "@/chat/skills";

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


class FakeSlackAdapter {
  readonly promptCalls: Array<{
    channelId: string;
    prompts: Array<{ message: string; title: string }>;
    threadTs: string;
  }> = [];
  readonly titleCalls: Array<{
    channelId: string;
    threadTs: string;
    title: string;
  }> = [];

  async setAssistantTitle(channelId: string, threadTs: string, title: string): Promise<void> {
    this.titleCalls.push({ channelId, threadTs, title });
  }

  async setSuggestedPrompts(
    channelId: string,
    threadTs: string,
    prompts: Array<{ message: string; title: string }>
  ): Promise<void> {
    this.promptCalls.push({ channelId, threadTs, prompts });
  }

}

class FakeThread {
  readonly channel: {
    state: Promise<Record<string, unknown>>;
    setState: (state: Record<string, unknown>, options?: { replace?: boolean }) => Promise<void>;
  };
  readonly channelId: string;
  readonly id: string;
  readonly posts: unknown[] = [];
  readonly recentMessages: Message[] = [];
  readonly runId?: string;
  readonly threadTs?: string;
  subscribeCalls = 0;
  subscribed = false;
  private stateData: Record<string, unknown> = {};

  constructor(args: {
    channelStateRef?: { value: Record<string, unknown> };
    id: string;
    runId?: string;
    state?: Record<string, unknown>;
    threadTs?: string;
  }) {
    this.id = args.id;
    this.channelId = parseSlackThreadId(args.id)?.channelId ?? "";
    this.runId = args.runId;
    this.threadTs = args.threadTs;
    this.stateData = { ...(args.state ?? {}) };
    const ref = args.channelStateRef ?? { value: {} };
    this.channel = {
      get state() {
        return Promise.resolve(ref.value);
      },
      async setState(nextState: Record<string, unknown>, options?: { replace?: boolean }) {
        if (options?.replace) {
          ref.value = { ...nextState };
          return;
        }
        ref.value = { ...ref.value, ...nextState };
      }
    };
  }

  get state(): Promise<Record<string, unknown>> {
    return Promise.resolve(this.stateData);
  }

  async post(message: unknown): Promise<{ edit(newContent: unknown): Promise<unknown> }> {
    if (
      message &&
      typeof message === "object" &&
      Symbol.asyncIterator in (message as Record<PropertyKey, unknown>)
    ) {
      let text = "";
      for await (const chunk of message as AsyncIterable<string>) {
        text += chunk;
      }
      this.posts.push(text);
      const self = this;
      return {
        async edit(newContent: unknown): Promise<unknown> {
          self.posts.push(newContent);
          return newContent;
        }
      };
    }

    this.posts.push(message);
    return {
      async edit(newContent: unknown): Promise<unknown> {
        return newContent;
      }
    };
  }

  get messages(): AsyncIterable<never> {
    return (async function* () {})();
  }

  async refresh(): Promise<void> {
    // No-op for eval harness.
  }

  async startTyping(_status?: string): Promise<void> {
    // No-op for eval harness.
  }

  async subscribe(): Promise<void> {
    this.subscribed = true;
    this.subscribeCalls += 1;
  }

  async setState(state: Record<string, unknown>, options?: { replace?: boolean }): Promise<void> {
    if (options?.replace) {
      this.stateData = { ...state };
      return;
    }
    this.stateData = { ...this.stateData, ...state };
  }
}

export interface AgentTurn {
  tool_calls: string[];
  sandbox_id: string | null;
  success: boolean;
}

export interface BehaviorCaseResult {
  posts: string[];
  slackAdapter: FakeSlackAdapter;
  turns: AgentTurn[];
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
  const threadsById = new Map<string, FakeThread>();
  const channelStateById = new Map<string, { value: Record<string, unknown> }>();
  const replyTexts = testCase.behavior?.reply_texts ?? [];
  const subscribedDecisions = testCase.behavior?.subscribed_decisions ?? [];
  const replyTimeoutMs = Number.parseInt(process.env.EVAL_AGENT_REPLY_TIMEOUT_MS ?? "45000", 10);
  const turns: AgentTurn[] = [];
  let replyCallCount = 0;
  let decisionIndex = 0;
  const originalSkillDirs = process.env.SKILL_DIRS;
  const originalEnableTestCredentials = process.env.EVAL_ENABLE_TEST_CREDENTIALS;
  const originalTestCredentialToken = process.env.EVAL_TEST_CREDENTIAL_TOKEN;
  const configuredSkillDirs =
    testCase.behavior?.skill_dirs?.map((entry) => path.resolve(process.cwd(), entry)) ?? [];
  if (configuredSkillDirs.length > 0) {
    process.env.SKILL_DIRS = configuredSkillDirs.join(path.delimiter);
    resetSkillDiscoveryCache();
  }
  if (testCase.behavior?.enable_test_credentials) {
    process.env.EVAL_ENABLE_TEST_CREDENTIALS = "1";
    if (testCase.behavior?.test_credential_token) {
      process.env.EVAL_TEST_CREDENTIAL_TOKEN = testCase.behavior.test_credential_token;
    }
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

  const getThread = (fixture: BehaviorEventThreadFixture): FakeThread => {
    const existing = threadsById.get(fixture.id);
    if (existing) {
      return existing;
    }
    const created = new FakeThread({
      id: fixture.id,
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
          generateAssistantReply(text, context),
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

      turns.push({
        tool_calls: reply.diagnostics.toolCalls,
        sandbox_id: reply.sandboxId ?? null,
        success: reply.diagnostics.outcome === "success",
      });

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
        await appSlackRuntime.handleNewMention(thread as any, toIncomingMessage(event) as any);
        continue;
      }

      if (event.type === "subscribed_message") {
        const thread = getThread(event.thread);
        await appSlackRuntime.handleSubscribedMessage(thread as any, toIncomingMessage(event) as any);
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
    if (configuredSkillDirs.length > 0) {
      if (originalSkillDirs === undefined) {
        delete process.env.SKILL_DIRS;
      } else {
        process.env.SKILL_DIRS = originalSkillDirs;
      }
      resetSkillDiscoveryCache();
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
    posts,
    slackAdapter,
    turns
  };
}

// ── Compile-time guards ──────────────────────────────────────────────
// These assertions ensure FakeThread and toIncomingMessage stay in sync
// with the SDK's Thread and Message types. If bot.ts starts accessing a
// new property, typecheck will fail here rather than silently at runtime.
type AssertAssignable<_TSub extends TSuper, TSuper> = true;
type _ThreadCheck = AssertAssignable<FakeThread, Pick<Thread, "id" | "channelId" | "state" | "setState" | "subscribe" | "startTyping" | "recentMessages" | "messages" | "refresh"> & { channel: Pick<Thread["channel"], "state" | "setState">; post: (...args: unknown[]) => Promise<unknown> }>;
type _MessageCheck = AssertAssignable<ReturnType<typeof toIncomingMessage>, Pick<Message, "id" | "text" | "isMention" | "attachments" | "metadata" | "author">>;

