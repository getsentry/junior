import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  createAppSlackRuntime,
  type AppRuntimeAssistantLifecycleEvent,
  type AppRuntimeIncomingMessage,
  type AppRuntimeReplyDecision,
  type AppRuntimeThreadContext,
  type AppRuntimeThreadHandle
} from "@/chat/app-runtime";

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

type BehaviorCaseEvent =
  | MentionEvent
  | SubscribedMessageEvent
  | AssistantThreadStartedEvent
  | AssistantContextChangedEvent;

interface BehaviorCaseExpectation {
  adapter_prompt_calls?: number;
  adapter_title_calls?: number;
  exception_events?: string[];
  min_posts?: number;
  posts_contain?: string[];
  posts_count?: number;
  primary_thread_subscribed?: boolean;
  warning_events?: string[];
}

interface SubscribedDecisionFixture {
  reason: string;
  should_reply: boolean;
}

interface BehaviorCaseConfig {
  fail_reply_call?: number;
  reply_texts?: string[];
  subscribed_decisions?: SubscribedDecisionFixture[];
}

export interface BehaviorEvalCase {
  behavior?: BehaviorCaseConfig;
  description: string;
  events: BehaviorCaseEvent[];
  expected: BehaviorCaseExpectation;
  id: string;
}

export interface BehaviorEvalSuite {
  cases: BehaviorEvalCase[];
  description?: string;
  name: string;
  schema_version: string;
}

interface EvalPreparedState {
  context: AppRuntimeThreadContext;
  conversationContext?: string;
  routingContext?: string;
  userText: string;
}

interface EvalLogEntry {
  eventName: string;
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

class FakeThread implements AppRuntimeThreadHandle {
  readonly id: string;
  readonly posts: unknown[] = [];
  readonly runId?: string;
  subscribeCalls = 0;
  subscribed = false;
  private stateData: Record<string, unknown> = {};

  constructor(args: {
    id: string;
    runId?: string;
    state?: Record<string, unknown>;
  }) {
    this.id = args.id;
    this.runId = args.runId;
    this.stateData = { ...(args.state ?? {}) };
  }

  get state(): Promise<Record<string, unknown>> {
    return Promise.resolve(this.stateData);
  }

  async post(message: unknown): Promise<unknown> {
    this.posts.push(message);
    return message;
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

interface BehaviorCaseResult {
  exceptions: EvalLogEntry[];
  posts: string[];
  primaryThread?: FakeThread;
  slackAdapter: FakeSlackAdapter;
  warnings: EvalLogEntry[];
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

function toIncomingMessage(
  event: MentionEvent | SubscribedMessageEvent
): AppRuntimeIncomingMessage {
  return {
    id: event.message.id,
    text: event.message.text ?? "",
    isMention: event.message.is_mention,
    channelId: event.thread.channel_id,
    threadId: event.thread.id,
    threadTs: event.thread.thread_ts,
    runId: event.thread.run_id,
    author: {
      userId: event.message.author?.user_id,
      userName: event.message.author?.user_name,
      fullName: event.message.author?.full_name,
      isMe: event.message.author?.is_me ?? false,
      isBot: event.message.author?.is_bot
    }
  };
}

function ensureSuiteShape(value: unknown): BehaviorEvalSuite {
  if (!value || typeof value !== "object") {
    throw new Error("Behavior eval suite must be an object.");
  }
  const suite = value as BehaviorEvalSuite;
  if (!suite.name || !Array.isArray(suite.cases)) {
    throw new Error("Behavior eval suite must include `name` and `cases`.");
  }
  return suite;
}

export function loadBehaviorEvalSuite(suitePath: string): BehaviorEvalSuite {
  const absolute = path.resolve(suitePath);
  const raw = fs.readFileSync(absolute, "utf8");
  return ensureSuiteShape(parseYaml(raw));
}

export async function runBehaviorEvalCase(testCase: BehaviorEvalCase): Promise<BehaviorCaseResult> {
  const slackAdapter = new FakeSlackAdapter();
  const warnings: EvalLogEntry[] = [];
  const exceptions: EvalLogEntry[] = [];
  const threadsById = new Map<string, FakeThread>();
  const replyTexts = testCase.behavior?.reply_texts ?? [];
  const subscribedDecisions = testCase.behavior?.subscribed_decisions ?? [];
  let replyCallCount = 0;
  let decisionIndex = 0;

  const getThread = (fixture: BehaviorEventThreadFixture): FakeThread => {
    const existing = threadsById.get(fixture.id);
    if (existing) {
      return existing;
    }
    const created = new FakeThread({
      id: fixture.id,
      runId: fixture.run_id
    });
    threadsById.set(fixture.id, created);
    return created;
  };

  const runtime = createAppSlackRuntime<EvalPreparedState, FakeThread, AppRuntimeIncomingMessage>({
    assistantUserName: "app",
    modelId: "eval-model",
    now: () => Date.now(),
    getThreadId: (thread, message) => thread.id ?? message.threadId ?? message.threadTs,
    getChannelId: (message) => message.channelId,
    getWorkflowRunId: (thread, message) => thread.runId ?? message.runId,
    stripLeadingBotMention: (text, options) => {
      let next = text;
      if (options.stripLeadingSlackMentionToken) {
        next = next.replace(/^\s*<@[^>]+>[\s,:-]*/, "");
      }
      next = next.replace(/^\s*@app\b[\s,:-]*/i, "");
      return next.trim();
    },
    withSpan: async (_name, _op, _context, callback) => {
      await callback();
    },
    logWarn: (eventName) => {
      warnings.push({ eventName });
    },
    logException: (_error, eventName) => {
      exceptions.push({ eventName });
    },
    prepareTurnState: async ({ thread, userText, context }) => {
      const state = (await thread.state) ?? {};
      const priorUserText =
        typeof state.app_eval_last_user_text === "string" ? state.app_eval_last_user_text : undefined;

      return {
        context,
        userText,
        conversationContext: priorUserText ? `Previous user message: ${priorUserText}` : undefined,
        routingContext: priorUserText ? `Previous user message: ${priorUserText}` : undefined
      };
    },
    persistPreparedState: async ({ thread, preparedState }) => {
      await thread.setState?.({
        app_eval_last_prepared_user_text: preparedState.userText
      });
    },
    getPreparedConversationContext: (preparedState) =>
      preparedState.routingContext ?? preparedState.conversationContext,
    shouldReplyInSubscribedThread: async (args): Promise<AppRuntimeReplyDecision> => {
      if (args.isExplicitMention) {
        return {
          shouldReply: true,
          reason: "explicit mention"
        };
      }
      if (decisionIndex < subscribedDecisions.length) {
        const next = subscribedDecisions[decisionIndex];
        decisionIndex += 1;
        return {
          shouldReply: next.should_reply,
          reason: next.reason
        };
      }
      return {
        shouldReply: false,
        reason: "passive conversation"
      };
    },
    onSubscribedMessageSkipped: async ({ thread, decision, completedAtMs }) => {
      await thread.setState?.({
        app_eval_last_skip_reason: decision.reason,
        app_eval_last_completed_at_ms: completedAtMs
      });
    },
    replyToThread: async (thread, message) => {
      replyCallCount += 1;
      if (testCase.behavior?.fail_reply_call === replyCallCount) {
        throw new Error(`forced reply failure on call ${replyCallCount}`);
      }

      const text = (message.text ?? "").trim();
      const state = (await thread.state) ?? {};
      const lastUserText =
        typeof state.app_eval_last_user_text === "string" ? state.app_eval_last_user_text : undefined;

      let replyText = replyTexts[replyCallCount - 1];
      if (!replyText) {
        if (/what did i just ask\??/i.test(text) && lastUserText) {
          replyText = `You just asked: ${lastUserText}`;
        } else {
          replyText = `Handled: ${text || "[non-text message]"}`;
        }
      }

      await thread.post(replyText);
      await thread.setState?.({
        app_eval_last_user_text: text
      });
    },
    initializeAssistantThread: async (event) => {
      await slackAdapter.setAssistantTitle(event.channelId, event.threadTs, "App");
      await slackAdapter.setSuggestedPrompts(event.channelId, event.threadTs, [
        { title: "Summarize thread", message: "Summarize this thread." },
        { title: "Draft a reply", message: "Draft a reply to this thread." }
      ]);
    }
  });

  for (const event of testCase.events) {
    if (event.type === "new_mention") {
      const thread = getThread(event.thread);
      await runtime.handleNewMention(thread, toIncomingMessage(event));
      continue;
    }

    if (event.type === "subscribed_message") {
      const thread = getThread(event.thread);
      await runtime.handleSubscribedMessage(thread, toIncomingMessage(event));
      continue;
    }

    const lifecycleEvent: AppRuntimeAssistantLifecycleEvent = {
      threadId: event.thread.id,
      channelId: event.thread.channel_id ?? "C_EVAL",
      threadTs: event.thread.thread_ts ?? "0",
      userId: event.user_id
    };
    if (event.type === "assistant_thread_started") {
      await runtime.handleAssistantThreadStarted(lifecycleEvent);
      continue;
    }

    await runtime.handleAssistantContextChanged(lifecycleEvent);
  }

  const primaryThreadId = testCase.events[0]?.thread.id;
  const primaryThread = primaryThreadId ? threadsById.get(primaryThreadId) : undefined;
  const posts = [...threadsById.values()].flatMap((thread) => thread.posts.map(toPostedText));

  return {
    posts,
    warnings,
    exceptions,
    primaryThread,
    slackAdapter
  };
}

function formatFailure(message: string, result: BehaviorCaseResult): string {
  return [
    message,
    `posts=${JSON.stringify(result.posts)}`,
    `warnings=${JSON.stringify(result.warnings.map((entry) => entry.eventName))}`,
    `exceptions=${JSON.stringify(result.exceptions.map((entry) => entry.eventName))}`
  ].join(" | ");
}

export function assertBehaviorEvalCase(
  testCase: BehaviorEvalCase,
  result: BehaviorCaseResult
): void {
  const expected = testCase.expected;
  if (expected.posts_count !== undefined && result.posts.length !== expected.posts_count) {
    throw new Error(
      formatFailure(
        `expected posts_count=${expected.posts_count} but got ${result.posts.length}`,
        result
      )
    );
  }

  if (expected.min_posts !== undefined && result.posts.length < expected.min_posts) {
    throw new Error(
      formatFailure(`expected at least ${expected.min_posts} posts but got ${result.posts.length}`, result)
    );
  }

  for (const fragment of expected.posts_contain ?? []) {
    if (!result.posts.some((post) => post.includes(fragment))) {
      throw new Error(formatFailure(`expected a post containing ${JSON.stringify(fragment)}`, result));
    }
  }

  if (
    expected.primary_thread_subscribed !== undefined &&
    Boolean(result.primaryThread?.subscribed) !== expected.primary_thread_subscribed
  ) {
    throw new Error(
      formatFailure(
        `expected primary_thread_subscribed=${expected.primary_thread_subscribed} but got ${Boolean(result.primaryThread?.subscribed)}`,
        result
      )
    );
  }

  if (
    expected.adapter_title_calls !== undefined &&
    result.slackAdapter.titleCalls.length !== expected.adapter_title_calls
  ) {
    throw new Error(
      formatFailure(
        `expected adapter_title_calls=${expected.adapter_title_calls} but got ${result.slackAdapter.titleCalls.length}`,
        result
      )
    );
  }

  if (
    expected.adapter_prompt_calls !== undefined &&
    result.slackAdapter.promptCalls.length !== expected.adapter_prompt_calls
  ) {
    throw new Error(
      formatFailure(
        `expected adapter_prompt_calls=${expected.adapter_prompt_calls} but got ${result.slackAdapter.promptCalls.length}`,
        result
      )
    );
  }

  for (const eventName of expected.warning_events ?? []) {
    if (!result.warnings.some((entry) => entry.eventName === eventName)) {
      throw new Error(formatFailure(`expected warning event ${eventName}`, result));
    }
  }

  for (const eventName of expected.exception_events ?? []) {
    if (!result.exceptions.some((entry) => entry.eventName === eventName)) {
      throw new Error(formatFailure(`expected exception event ${eventName}`, result));
    }
  }
}
