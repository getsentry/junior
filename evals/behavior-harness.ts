import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  type AppRuntimeAssistantLifecycleEvent,
  type AppRuntimeThreadHandle
} from "@/chat/app-runtime";
import { appSlackRuntime, bot, resetBotDepsForTests, setBotDepsForTests } from "@/chat/bot";
import { registerLogRecordSink, type EmittedLogRecord } from "@/chat/logging";
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

type BehaviorCaseEvent =
  | MentionEvent
  | SubscribedMessageEvent
  | AssistantThreadStartedEvent
  | AssistantContextChangedEvent;

interface BehaviorCaseExpectation {
  adapter_prompt_calls?: number;
  adapter_title_calls?: number;
  exception_events?: string[];
  log_events?: string[];
  log_event_attributes?: Array<{
    event: string;
    key: string;
  }>;
  min_posts?: number;
  posts_count?: number;
  post_contains?: string[];
  primary_thread_subscribed?: boolean;
  sandbox_id_present?: boolean;
  sandbox_ids_count?: number;
  sandbox_ids_unique_count?: number;
  tool_calls_include?: string[];
  warning_events?: string[];
}

interface SubscribedDecisionFixture {
  reason: string;
  should_reply: boolean;
}

interface BehaviorCaseConfig {
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

const threadSchema = z.object({
  id: z.string().min(1),
  channel_id: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
  thread_ts: z.string().min(1).optional()
});

const messageSchema = z.object({
  author: z
    .object({
      full_name: z.string().min(1).optional(),
      is_bot: z.boolean().optional(),
      is_me: z.boolean().optional(),
      user_id: z.string().min(1).optional(),
      user_name: z.string().min(1).optional()
    })
    .optional(),
  id: z.string().min(1).optional(),
  is_mention: z.boolean().optional(),
  text: z.string().optional()
});

const eventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("new_mention"),
    thread: threadSchema,
    message: messageSchema
  }),
  z.object({
    type: z.literal("subscribed_message"),
    thread: threadSchema,
    message: messageSchema
  }),
  z.object({
    type: z.literal("assistant_thread_started"),
    thread: threadSchema,
    user_id: z.string().min(1).optional()
  }),
  z.object({
    type: z.literal("assistant_context_changed"),
    thread: threadSchema,
    user_id: z.string().min(1).optional()
  })
]);

const expectationSchema = z.object({
  adapter_prompt_calls: z.number().int().nonnegative().optional(),
  adapter_title_calls: z.number().int().nonnegative().optional(),
  exception_events: z.array(z.string().min(1)).optional(),
  log_events: z.array(z.string().min(1)).optional(),
  log_event_attributes: z
    .array(
      z.object({
        event: z.string().min(1),
        key: z.string().min(1)
      })
    )
    .optional(),
  min_posts: z.number().int().nonnegative().optional(),
  posts_count: z.number().int().nonnegative().optional(),
  post_contains: z.array(z.string().min(1)).optional(),
  primary_thread_subscribed: z.boolean().optional(),
  sandbox_id_present: z.boolean().optional(),
  sandbox_ids_count: z.number().int().nonnegative().optional(),
  sandbox_ids_unique_count: z.number().int().nonnegative().optional(),
  tool_calls_include: z.array(z.string().min(1)).optional(),
  warning_events: z.array(z.string().min(1)).optional()
});

const caseSchema = z.object({
  behavior: z
    .object({
      fail_reply_call: z.number().int().positive().optional(),
      enable_test_credentials: z.boolean().optional(),
      skill_dirs: z.array(z.string().min(1)).optional(),
      test_credential_token: z.string().min(1).optional(),
      unset_gateway_api_key: z.boolean().optional(),
      reply_texts: z.array(z.string()).optional(),
      subscribed_decisions: z
        .array(
          z.object({
            reason: z.string().min(1),
            should_reply: z.boolean()
          })
        )
        .optional()
    })
    .optional(),
  description: z.string().min(1),
  events: z.array(eventSchema).min(1),
  expected: expectationSchema,
  id: z.string().min(1)
});

const suiteSchema = z.object({
  schema_version: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  cases: z.array(caseSchema)
});

interface EvalLogEntry {
  eventName: string;
}

interface EvalLogRecord {
  attributes: Record<string, string | number | boolean | string[]>;
  body: string;
  eventName: string;
  level: string;
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

  async setAssistantStatus(): Promise<void> {
    // No-op for eval harness.
  }
}

class FakeThread implements AppRuntimeThreadHandle {
  readonly channel?: {
    state: Promise<Record<string, unknown>>;
    setState: (state: Record<string, unknown>, options?: { replace?: boolean }) => Promise<void>;
  };
  readonly id: string;
  readonly posts: unknown[] = [];
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
    this.runId = args.runId;
    this.threadTs = args.threadTs;
    this.stateData = { ...(args.state ?? {}) };
    if (args.channelStateRef) {
      this.channel = {
        get state() {
          return Promise.resolve(args.channelStateRef?.value ?? {});
        },
        async setState(nextState: Record<string, unknown>, options?: { replace?: boolean }) {
          if (options?.replace) {
            args.channelStateRef!.value = { ...nextState };
            return;
          }
          args.channelStateRef!.value = { ...args.channelStateRef!.value, ...nextState };
        }
      };
    }
  }

  get state(): Promise<Record<string, unknown>> {
    return Promise.resolve(this.stateData);
  }

  async post(message: unknown): Promise<unknown> {
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
  logs: EvalLogRecord[];
  posts: string[];
  primaryThread?: FakeThread;
  sandboxIds: string[];
  slackAdapter: FakeSlackAdapter;
  toolCalls: string[];
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

function toIncomingMessage(event: MentionEvent | SubscribedMessageEvent) {
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
  const parsed = suiteSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const issuePath = issue?.path.length ? issue.path.join(".") : "suite";
    const issueMessage = issue?.message ?? "invalid schema";
    throw new Error(`Invalid behavior eval suite at ${issuePath}: ${issueMessage}`);
  }
  return parsed.data;
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
  const logs: EvalLogRecord[] = [];
  const threadsById = new Map<string, FakeThread>();
  const channelStateById = new Map<string, { value: Record<string, unknown> }>();
  const replyTexts = testCase.behavior?.reply_texts ?? [];
  const subscribedDecisions = testCase.behavior?.subscribed_decisions ?? [];
  const replyTimeoutMs = Number.parseInt(process.env.EVAL_AGENT_REPLY_TIMEOUT_MS ?? "45000", 10);
  const sandboxIds: string[] = [];
  const toolCalls: string[] = [];
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

  const unregisterLogSink = registerLogRecordSink((record: EmittedLogRecord) => {
    logs.push({
      eventName: record.eventName,
      level: record.level,
      body: record.body,
      attributes: record.attributes
    });
  });
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

      toolCalls.push(...reply.diagnostics.toolCalls);
      if (reply.sandboxId) {
        sandboxIds.push(reply.sandboxId);
      }
      warnings.push({ eventName: `agent_turn_${reply.diagnostics.outcome}` });
      if (reply.diagnostics.stopReason) {
        warnings.push({ eventName: `agent_turn_stop_reason_${reply.diagnostics.stopReason}` });
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
    unregisterLogSink();
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

  for (const log of logs) {
    if (log.level === "warn") {
      warnings.push({ eventName: log.eventName });
    } else if (log.level === "error") {
      exceptions.push({ eventName: log.eventName });
    }
  }

  const primaryThreadId = testCase.events[0]?.thread.id;
  const primaryThread = primaryThreadId ? threadsById.get(primaryThreadId) : undefined;
  const posts = [...threadsById.values()].flatMap((thread) => thread.posts.map(toPostedText));

  return {
    logs,
    posts,
    sandboxIds,
    warnings,
    exceptions,
    primaryThread,
    slackAdapter,
    toolCalls
  };
}

function formatFailure(message: string, result: BehaviorCaseResult): string {
  return [
    message,
    `sandbox_ids=${JSON.stringify(result.sandboxIds)}`,
    `log_events=${JSON.stringify(result.logs.map((entry) => entry.eventName))}`,
    `posts=${JSON.stringify(result.posts)}`,
    `tool_calls=${JSON.stringify(result.toolCalls)}`,
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

  for (const snippet of expected.post_contains ?? []) {
    const found = result.posts.some((post) => post.includes(snippet));
    if (!found) {
      throw new Error(formatFailure(`expected post containing ${JSON.stringify(snippet)}`, result));
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

  for (const toolName of expected.tool_calls_include ?? []) {
    if (!result.toolCalls.includes(toolName)) {
      throw new Error(formatFailure(`expected tool call ${toolName}`, result));
    }
  }

  if (expected.sandbox_id_present !== undefined) {
    const hasSandboxId = result.sandboxIds.length > 0;
    if (hasSandboxId !== expected.sandbox_id_present) {
      throw new Error(
        formatFailure(`expected sandbox_id_present=${expected.sandbox_id_present} but got ${hasSandboxId}`, result)
      );
    }
  }

  if (expected.sandbox_ids_count !== undefined && result.sandboxIds.length !== expected.sandbox_ids_count) {
    throw new Error(
      formatFailure(`expected sandbox_ids_count=${expected.sandbox_ids_count} but got ${result.sandboxIds.length}`, result)
    );
  }

  if (expected.sandbox_ids_unique_count !== undefined) {
    const uniqueCount = new Set(result.sandboxIds).size;
    if (uniqueCount !== expected.sandbox_ids_unique_count) {
      throw new Error(
        formatFailure(
          `expected sandbox_ids_unique_count=${expected.sandbox_ids_unique_count} but got ${uniqueCount}`,
          result
        )
      );
    }
  }

  for (const eventName of expected.log_events ?? []) {
    if (!result.logs.some((entry) => entry.eventName === eventName)) {
      throw new Error(formatFailure(`expected log event ${eventName}`, result));
    }
  }

  for (const expectation of expected.log_event_attributes ?? []) {
    const matched = result.logs.some(
      (entry) =>
        entry.eventName === expectation.event && Object.prototype.hasOwnProperty.call(entry.attributes, expectation.key)
    );
    if (!matched) {
      throw new Error(
        formatFailure(
          `expected log attribute ${expectation.key} on event ${expectation.event}`,
          result
        )
      );
    }
  }
}
