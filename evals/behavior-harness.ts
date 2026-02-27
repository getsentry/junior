import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  createAppSlackRuntime,
  type AppRuntimeAssistantLifecycleEvent,
  type AppRuntimeIncomingMessage,
  type AppRuntimeReplyDecision,
  type AppRuntimeThreadContext,
  type AppRuntimeThreadHandle
} from "@/chat/app-runtime";
import { createChannelConfigurationService } from "@/chat/configuration/service";
import type { ChannelConfigurationService } from "@/chat/configuration/types";
import { registerLogRecordSink, type EmittedLogRecord } from "@/chat/logging";
import { generateAssistantReply } from "@/chat/respond";
import { resetSkillDiscoveryCache } from "@/chat/skills";
import { buildArtifactStatePatch, coerceThreadArtifactsState } from "@/chat/slack-actions/types";

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

interface EvalPreparedState {
  context: AppRuntimeThreadContext;
  conversationContext?: string;
  routingContext?: string;
  userText: string;
}

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
  const channelStateById = new Map<string, Record<string, unknown>>();
  const channelConfigurationById = new Map<string, ChannelConfigurationService>();
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

  const getChannelConfiguration = (channelId: string | undefined): ChannelConfigurationService | undefined => {
    const normalizedChannelId = channelId?.trim();
    if (!normalizedChannelId) {
      return undefined;
    }

    const existing = channelConfigurationById.get(normalizedChannelId);
    if (existing) {
      return existing;
    }

    const created = createChannelConfigurationService({
      load: async () => channelStateById.get(normalizedChannelId) ?? null,
      save: async (state) => {
        channelStateById.set(normalizedChannelId, {
          configuration: state
        });
      }
    });
    channelConfigurationById.set(normalizedChannelId, created);
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
    replyToThread: async (thread, message, options) => {
      replyCallCount += 1;
      if (testCase.behavior?.fail_reply_call === replyCallCount) {
        throw new Error(`forced reply failure on call ${replyCallCount}`);
      }

      const text = (message.text ?? "").trim();
      const persisted = (await thread.state) ?? {};
      const preparedConversationContext =
        options?.preparedState?.routingContext ?? options?.preparedState?.conversationContext;
      const persistedSandboxId =
        typeof persisted.app_sandbox_id === "string" ? persisted.app_sandbox_id : undefined;
      const channelConfiguration = getChannelConfiguration(message.channelId);
      const configuration = channelConfiguration ? await channelConfiguration.resolveValues() : {};

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
            assistant: {
              userName: "junior"
            },
            requester: {
              userId: message.author.userId,
              userName: message.author.userName,
              fullName: message.author.fullName
            },
            conversationContext: preparedConversationContext,
            artifactState: coerceThreadArtifactsState(persisted),
            configuration,
            channelConfiguration,
            correlation: {
              threadId: thread.id,
              threadTs: message.threadTs,
              workflowRunId: thread.runId,
              channelId: message.channelId,
              requesterId: message.author.userId
            },
            sandbox: {
              sandboxId: persistedSandboxId
            }
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

      const replyText = replyTexts[replyCallCount - 1] ?? reply.text;
      await thread.post(replyText);
      warnings.push({
        eventName: `agent_turn_${reply.diagnostics.outcome}`
      });
      toolCalls.push(...reply.diagnostics.toolCalls);
      if (reply.diagnostics.stopReason) {
        warnings.push({
          eventName: `agent_turn_stop_reason_${reply.diagnostics.stopReason}`
        });
      }

      const nextState: Record<string, unknown> = {
        app_eval_last_user_text: text
      };
      if (reply.sandboxId) {
        nextState.app_sandbox_id = reply.sandboxId;
        sandboxIds.push(reply.sandboxId);
      }
      if (reply.artifactStatePatch && Object.keys(reply.artifactStatePatch).length > 0) {
        Object.assign(nextState, buildArtifactStatePatch(reply.artifactStatePatch));
      }
      await thread.setState?.(nextState);
    },
    initializeAssistantThread: async (event) => {
      await slackAdapter.setAssistantTitle(event.channelId, event.threadTs, "App");
      await slackAdapter.setSuggestedPrompts(event.channelId, event.threadTs, [
        { title: "Summarize thread", message: "Summarize this thread." },
        { title: "Draft a reply", message: "Draft a reply to this thread." }
      ]);
    }
  });

  try {
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
  } finally {
    unregisterLogSink();
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
