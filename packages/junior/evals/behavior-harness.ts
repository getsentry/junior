import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Message } from "chat";
import type { AppRuntimeAssistantLifecycleEvent } from "@/chat/app-runtime";
import { getUserTokenStore } from "@/chat/capabilities/factory";
import {
  appSlackRuntime,
  bot,
  resetBotDepsForTests,
  setBotDepsForTests,
} from "@/chat/bot";
import {
  deleteMcpAuthSessionsForUserProvider,
  deleteMcpServerSessionId,
  deleteMcpStoredOAuthCredentials,
  getLatestMcpAuthSessionForUserProvider,
} from "@/chat/mcp/auth-store";
import {
  getPluginOAuthConfig,
  setAdditionalPluginRootsForTests,
} from "@/chat/plugins/registry";
import { generateAssistantReply } from "@/chat/respond";
import { getStateAdapter } from "@/chat/state";
import { resetSkillDiscoveryCache } from "@/chat/skills";
import { RetryableTurnError, isRetryableTurnError } from "@/chat/turn/errors";
import { setPostSlackMessageObserverForTests } from "@/handlers/oauth-resume";
import {
  FakeSlackAdapter,
  createTestThread,
  type TestThread,
} from "../tests/fixtures/slack-harness";
import {
  EVAL_OAUTH_CODE,
  EVAL_OAUTH_PROVIDER,
} from "../tests/msw/handlers/eval-oauth";
import {
  EVAL_MCP_AUTH_CODE,
  EVAL_MCP_AUTH_PROVIDER,
} from "../tests/msw/handlers/eval-mcp-auth";
import { runMcpOauthCallbackRoute } from "../tests/fixtures/mcp-oauth-callback-harness";
import { runOauthCallbackRoute } from "../tests/fixtures/oauth-callback-harness";
import {
  readCapturedSlackApiCalls,
  type CapturedSlackApiCall,
} from "../tests/msw/captured-slack-api-calls";
import type { ImageGenerateToolDeps } from "@/chat/tools/types";

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
  auto_complete_mcp_oauth?: string[];
  auto_complete_oauth?: string[];
  enable_test_credentials?: boolean;
  fail_reply_call?: number;
  mock_image_generation?: boolean;
  plugin_dirs?: string[];
  mock_slack_api?: boolean;
  plugin_packages?: string[];
  reply_texts?: string[];
  retryable_max_attempts?: number;
  retryable_timeout_calls?: number[];
  retryable_timeout_message?: string;
  skill_dirs?: string[];
  subscribed_decisions?: SubscribedDecisionFixture[];
  test_credential_token?: string;
  unset_gateway_api_key?: boolean;
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

const EVAL_PACKAGE_ROOT = path.resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);
type HarnessStateAdapter = ReturnType<typeof getStateAdapter>;

function resolveEvalRelativePath(entry: string): string {
  return path.isAbsolute(entry)
    ? entry
    : path.resolve(EVAL_PACKAGE_ROOT, entry);
}

function toFirstString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const resolved = toFirstString(entry);
      if (resolved) return resolved;
    }
  }
  return undefined;
}

function buildRuntimeThreadId(fixture: BehaviorEventThreadFixture): string {
  if (fixture.channel_id && fixture.thread_ts) {
    return `slack:${fixture.channel_id}:${fixture.thread_ts}`;
  }
  return fixture.id;
}

const THREAD_STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

async function cleanupHarnessThreadState(
  stateAdapter: HarnessStateAdapter,
  events: readonly BehaviorCaseEvent[],
): Promise<void> {
  const runtimeThreadIds = new Set(
    events.map((event) => buildRuntimeThreadId(event.thread)),
  );
  const channelIds = new Set(
    events
      .map((event) => event.thread.channel_id?.trim())
      .filter((value): value is string => Boolean(value)),
  );

  for (const threadId of runtimeThreadIds) {
    await stateAdapter.delete(`thread-state:${threadId}`);
  }
  for (const channelId of channelIds) {
    await stateAdapter.delete(`channel-state:${channelId}`);
  }
}

function createEvalThread(args: {
  fixture: BehaviorEventThreadFixture;
  channelStateRef?: { value: Record<string, unknown> };
  stateAdapter: HarnessStateAdapter;
}): TestThread {
  const thread = createTestThread({
    id: buildRuntimeThreadId(args.fixture),
    channelId: args.fixture.channel_id,
    runId: args.fixture.run_id,
    threadTs: args.fixture.thread_ts,
    channelStateRef: args.channelStateRef,
  });
  const originalSetState = thread.setState.bind(thread);
  thread.setState = async (next, options) => {
    await originalSetState(next, options);
    await args.stateAdapter.set(
      `thread-state:${thread.id}`,
      thread.getState(),
      THREAD_STATE_TTL_MS,
    );
  };
  return thread;
}

function createMockImageGenerateDeps(): ImageGenerateToolDeps {
  const generatedImageBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH3cAAAAASUVORK5CYII=";

  return {
    fetch: async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url === "https://ai-gateway.vercel.sh/v1/chat/completions") {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  images: [
                    {
                      image_url: {
                        url: `data:image/png;base64,${generatedImageBase64}`,
                      },
                    },
                  ],
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      }
      return fetch(input, init);
    },
  };
}

export function collectSlackArtifactsFromCapturedCalls(
  calls: CapturedSlackApiCall[],
): Pick<BehaviorCaseResult, "channelPosts" | "reactions"> {
  const channelPosts: BehaviorCaseResult["channelPosts"] = [];
  const reactions: BehaviorCaseResult["reactions"] = [];

  for (const call of calls) {
    if (call.method === "chat.postMessage") {
      const channel = toFirstString(call.params.channel);
      const text = toFirstString(call.params.text);
      if (!channel || text === undefined) {
        continue;
      }
      const threadTs = toFirstString(call.params.thread_ts);
      channelPosts.push({
        channel,
        text,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      continue;
    }

    if (call.method === "reactions.add") {
      const channel = toFirstString(call.params.channel);
      const emoji = toFirstString(call.params.name);
      const timestamp = toFirstString(call.params.timestamp);
      if (!channel || !emoji || !timestamp) {
        continue;
      }
      reactions.push({
        channel,
        emoji,
        timestamp,
      });
    }
  }

  return {
    channelPosts,
    reactions,
  };
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
    const raw = (value as { raw?: unknown }).raw;
    if (typeof raw === "string") {
      return raw;
    }
    return "[non-text post]";
  }
  return String(value);
}

function toIncomingMessage(event: MentionEvent | SubscribedMessageEvent) {
  const runtimeThreadId = buildRuntimeThreadId(event.thread);
  // In Slack payloads, `ts` identifies the specific message while `thread_ts`
  // identifies the thread root. Eval fixtures provide unique `message.id` per
  // event, so prefer it for `raw.ts` to avoid collapsing all replies to the
  // same timestamp in multi-turn thread scenarios.
  const messageTs = event.message.id ?? event.thread.thread_ts;
  return {
    id: event.message.id ?? "",
    text: event.message.text ?? "",
    isMention: event.message.is_mention,
    attachments: [],
    metadata: { dateSent: new Date(), edited: false },
    channelId: event.thread.channel_id,
    threadId: runtimeThreadId,
    threadTs: event.thread.thread_ts,
    runId: event.thread.run_id,
    raw: {
      channel: event.thread.channel_id,
      ts: messageTs,
      thread_ts: event.thread.thread_ts,
    },
    author: {
      userId: event.message.author?.user_id ?? "U-eval",
      userName: event.message.author?.user_name ?? "",
      fullName: event.message.author?.full_name ?? "",
      isMe: event.message.author?.is_me ?? false,
      isBot: event.message.author?.is_bot ?? false,
    },
  };
}

async function cleanupMcpAuthState(
  userIds: Iterable<string>,
  providers: Iterable<string>,
): Promise<void> {
  for (const provider of providers) {
    for (const userId of userIds) {
      await deleteMcpAuthSessionsForUserProvider(userId, provider);
      await deleteMcpStoredOAuthCredentials(userId, provider);
      await deleteMcpServerSessionId(userId, provider);
    }
  }
}

async function cleanupOAuthTokens(
  userIds: Iterable<string>,
  providers: Iterable<string>,
): Promise<void> {
  const userTokenStore = getUserTokenStore();
  for (const provider of providers) {
    for (const userId of userIds) {
      await userTokenStore.delete(userId, provider);
    }
  }
}

function getDefaultMcpOauthCode(provider: string): string {
  if (provider === EVAL_MCP_AUTH_PROVIDER) {
    return EVAL_MCP_AUTH_CODE;
  }
  throw new Error(
    `No default eval MCP OAuth code configured for provider "${provider}"`,
  );
}

async function runMcpOauthCallback(args: {
  provider: string;
  requesterUserId: string;
}): Promise<boolean> {
  const provider = args.provider.trim() || EVAL_MCP_AUTH_PROVIDER;
  const requesterUserId = args.requesterUserId || "U-test";
  const authSession = await getLatestMcpAuthSessionForUserProvider(
    requesterUserId,
    provider,
  );

  if (!authSession) {
    return false;
  }

  const response = await runMcpOauthCallbackRoute({
    provider,
    state: authSession.authSessionId,
    code: getDefaultMcpOauthCode(provider),
  });

  if (response.status !== 200) {
    throw new Error(
      `MCP OAuth callback returned ${response.status}: ${await response.text()}`,
    );
  }
  return true;
}

function extractSlackLinkUrl(text: string): URL | undefined {
  const match = text.match(/<([^|>]+)\|/);
  if (!match?.[1]) {
    return undefined;
  }
  try {
    return new URL(match[1]);
  } catch {
    return undefined;
  }
}

function findLatestOAuthStateFromSlackCalls(args: {
  authorizeEndpoint: string;
  consumedStates: Set<string>;
}): string | undefined {
  const expectedUrl = new URL(args.authorizeEndpoint);
  const calls = readCapturedSlackApiCalls();

  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index];
    if (
      call.method !== "chat.postEphemeral" &&
      call.method !== "chat.postMessage"
    ) {
      continue;
    }
    const text = toFirstString(call.params.text);
    if (!text) {
      continue;
    }
    const authLink = extractSlackLinkUrl(text);
    if (!authLink) {
      continue;
    }
    if (
      authLink.origin !== expectedUrl.origin ||
      authLink.pathname !== expectedUrl.pathname
    ) {
      continue;
    }
    const state = authLink.searchParams.get("state")?.trim();
    if (state && !args.consumedStates.has(state)) {
      return state;
    }
  }
  return undefined;
}

function getDefaultOAuthCode(provider: string): string {
  if (provider === EVAL_OAUTH_PROVIDER) {
    return EVAL_OAUTH_CODE;
  }
  throw new Error(
    `No default eval OAuth code configured for provider "${provider}"`,
  );
}

async function runOauthCallback(args: {
  provider: string;
  consumedStates: Set<string>;
}): Promise<boolean> {
  const provider = args.provider.trim() || EVAL_OAUTH_PROVIDER;
  const providerConfig = getPluginOAuthConfig(provider);
  if (!providerConfig) {
    throw new Error(`Unknown OAuth provider "${provider}" in eval harness`);
  }

  const state = findLatestOAuthStateFromSlackCalls({
    authorizeEndpoint: providerConfig.authorizeEndpoint,
    consumedStates: args.consumedStates,
  });
  if (!state) {
    return false;
  }
  const response = await runOauthCallbackRoute({
    provider,
    state,
    code: getDefaultOAuthCode(provider),
  });

  if (response.status !== 200) {
    throw new Error(
      `OAuth callback returned ${response.status}: ${await response.text()}`,
    );
  }
  args.consumedStates.add(state);
  return true;
}

export async function runBehaviorEvalCase(
  testCase: BehaviorEvalCase,
): Promise<BehaviorCaseResult> {
  const slackAdapter = new FakeSlackAdapter();
  const resumedChannelPosts: BehaviorCaseResult["channelPosts"] = [];
  const threadsById = new Map<string, TestThread>();
  const channelStateById = new Map<
    string,
    { value: Record<string, unknown> }
  >();
  const replyTexts = testCase.behavior?.reply_texts ?? [];
  const retryableTimeoutCalls = new Set(
    testCase.behavior?.retryable_timeout_calls ?? [],
  );
  const retryableTimeoutMessage =
    testCase.behavior?.retryable_timeout_message ?? "simulated eval timeout";
  const retryableMaxAttempts = Math.max(
    1,
    testCase.behavior?.retryable_max_attempts ?? 3,
  );
  const subscribedDecisions = testCase.behavior?.subscribed_decisions ?? [];
  const replyTimeoutMs = Number.parseInt(
    process.env.EVAL_AGENT_REPLY_TIMEOUT_MS ?? "45000",
    10,
  );
  let replyCallCount = 0;
  let decisionIndex = 0;
  const originalEnableTestCredentials =
    process.env.EVAL_ENABLE_TEST_CREDENTIALS;
  const originalTestCredentialToken = process.env.EVAL_TEST_CREDENTIAL_TOKEN;
  const originalJuniorBaseUrl = process.env.JUNIOR_BASE_URL;
  const originalPluginPackages = process.env.JUNIOR_PLUGIN_PACKAGES;
  const originalSlackBotToken = process.env.SLACK_BOT_TOKEN;
  const originalStateAdapter = process.env.JUNIOR_STATE_ADAPTER;
  const configuredSkillDirs =
    testCase.behavior?.skill_dirs?.map((entry) =>
      resolveEvalRelativePath(entry),
    ) ?? [];
  const configuredPluginDirs =
    testCase.behavior?.plugin_dirs?.map((entry) =>
      resolveEvalRelativePath(entry),
    ) ?? [];
  const autoCompleteMcpOauthProviders = new Set(
    testCase.behavior?.auto_complete_mcp_oauth?.map((provider) =>
      provider.trim(),
    ) ?? [],
  );
  const autoCompleteOauthProviders = new Set(
    testCase.behavior?.auto_complete_oauth?.map((provider) =>
      provider.trim(),
    ) ?? [],
  );
  const authRequesterUsers = new Set(
    testCase.events.flatMap((event) =>
      "message" in event
        ? [event.message.author?.user_id?.trim() || "U-test"]
        : event.user_id
          ? [event.user_id]
          : [],
    ),
  );
  if (authRequesterUsers.size === 0) {
    authRequesterUsers.add("U-test");
  }
  const consumedOauthStates = new Set<string>();
  const consumedMcpAuthSessions = new Set<string>();
  if (testCase.behavior?.enable_test_credentials) {
    process.env.EVAL_ENABLE_TEST_CREDENTIALS = "1";
    if (testCase.behavior?.test_credential_token) {
      process.env.EVAL_TEST_CREDENTIAL_TOKEN =
        testCase.behavior.test_credential_token;
    }
  }
  if (testCase.behavior?.mock_slack_api) {
    process.env.SLACK_BOT_TOKEN = "xoxb-eval-test-token";
  }
  process.env.JUNIOR_BASE_URL = "https://junior.example.com";
  process.env.JUNIOR_STATE_ADAPTER = "memory";
  process.env.JUNIOR_PLUGIN_PACKAGES = JSON.stringify(
    testCase.behavior?.plugin_packages ?? [],
  );
  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();
  setAdditionalPluginRootsForTests(configuredPluginDirs);
  resetSkillDiscoveryCache();
  setPostSlackMessageObserverForTests(({ channelId, text, threadTs }) => {
    resumedChannelPosts.push({
      channel: channelId,
      text,
      thread_ts: threadTs,
    });
  });
  await cleanupHarnessThreadState(stateAdapter, testCase.events);
  await cleanupMcpAuthState(authRequesterUsers, autoCompleteMcpOauthProviders);
  await cleanupOAuthTokens(authRequesterUsers, autoCompleteOauthProviders);

  const maybeAutoCompleteAuth = async (): Promise<void> => {
    for (const provider of autoCompleteMcpOauthProviders) {
      for (const requesterUserId of authRequesterUsers) {
        const authSession = await getLatestMcpAuthSessionForUserProvider(
          requesterUserId,
          provider,
        );
        if (!authSession) {
          continue;
        }
        if (consumedMcpAuthSessions.has(authSession.authSessionId)) {
          continue;
        }
        const completed = await runMcpOauthCallback({
          provider,
          requesterUserId,
        });
        if (completed) {
          consumedMcpAuthSessions.add(authSession.authSessionId);
        }
      }
    }

    for (const provider of autoCompleteOauthProviders) {
      await runOauthCallback({
        provider,
        consumedStates: consumedOauthStates,
      });
    }
  };

  const getChannelStateRef = (
    channelId: string | undefined,
  ): { value: Record<string, unknown> } | undefined => {
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
    const created = createEvalThread({
      fixture,
      channelStateRef: getChannelStateRef(fixture.channel_id),
      stateAdapter,
    });
    threadsById.set(fixture.id, created);
    return created;
  };

  const originalGetAdapter = (
    bot as unknown as { getAdapter?: (name: string) => unknown }
  ).getAdapter?.bind(bot);
  (bot as unknown as { getAdapter: (name: string) => unknown }).getAdapter = (
    name: string,
  ): unknown => {
    if (name === "slack") {
      return slackAdapter;
    }
    return originalGetAdapter ? originalGetAdapter(name) : undefined;
  };

  setBotDepsForTests({
    completeObject: async () => {
      if (subscribedDecisions.length === 0) {
        return {
          object: {
            should_reply: false,
            confidence: 0,
            reason: "passive conversation",
          },
          text: '{"should_reply":false,"confidence":0,"reason":"passive conversation"}',
        } as any;
      }
      const next =
        subscribedDecisions[
          Math.min(decisionIndex, subscribedDecisions.length - 1)
        ];
      decisionIndex += 1;
      return {
        object: {
          should_reply: next.should_reply,
          confidence: next.should_reply ? 1 : 0,
          reason: next.reason,
        },
        text: JSON.stringify({
          should_reply: next.should_reply,
          confidence: next.should_reply ? 1 : 0,
          reason: next.reason,
        }),
      } as any;
    },
    generateAssistantReply: async (text, context) => {
      replyCallCount += 1;
      const mockImageGeneration = testCase.behavior?.mock_image_generation;
      if (retryableTimeoutCalls.has(replyCallCount)) {
        throw new RetryableTurnError(
          "agent_turn_timeout_resume",
          retryableTimeoutMessage,
        );
      }
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
            ...(configuredSkillDirs.length > 0
              ? { skillDirs: configuredSkillDirs }
              : {}),
            ...(mockImageGeneration
              ? {
                  toolOverrides: {
                    ...(context?.toolOverrides ?? {}),
                    imageGenerate: createMockImageGenerateDeps(),
                  },
                }
              : {}),
          }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    `generateAssistantReply timed out after ${replyTimeoutMs}ms`,
                  ),
                ),
              replyTimeoutMs,
            ),
          ),
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
          text: replyText,
        };
      }
      return reply;
    },
  });

  try {
    const runWithRetryableTurnHandling = async (
      run: () => Promise<void>,
    ): Promise<void> => {
      for (let attempt = 1; attempt <= retryableMaxAttempts; attempt += 1) {
        try {
          await run();
          return;
        } catch (error) {
          if (!isRetryableTurnError(error, "agent_turn_timeout_resume")) {
            throw error;
          }
          if (attempt >= retryableMaxAttempts) {
            throw error;
          }
        }
      }
    };

    for (const event of testCase.events) {
      if (event.type === "new_mention") {
        const thread = getThread(event.thread);
        await runWithRetryableTurnHandling(async () => {
          await appSlackRuntime.handleNewMention(
            thread,
            toIncomingMessage(event) as any,
          );
        });
        await maybeAutoCompleteAuth();
        continue;
      }

      if (event.type === "subscribed_message") {
        const thread = getThread(event.thread);
        await runWithRetryableTurnHandling(async () => {
          await appSlackRuntime.handleSubscribedMessage(
            thread,
            toIncomingMessage(event) as any,
          );
        });
        await maybeAutoCompleteAuth();
        continue;
      }

      const lifecycleEvent: AppRuntimeAssistantLifecycleEvent = {
        threadId: event.thread.id,
        channelId: event.thread.channel_id ?? "C_EVAL",
        threadTs: event.thread.thread_ts ?? "0",
        userId: event.user_id ?? "U-eval",
      };
      if (event.type === "assistant_thread_started") {
        await appSlackRuntime.handleAssistantThreadStarted(lifecycleEvent);
        await maybeAutoCompleteAuth();
        continue;
      }

      await appSlackRuntime.handleAssistantContextChanged(lifecycleEvent);
      await maybeAutoCompleteAuth();
    }
  } finally {
    resetBotDepsForTests();
    setAdditionalPluginRootsForTests([]);
    resetSkillDiscoveryCache();
    setPostSlackMessageObserverForTests(undefined);
    await cleanupHarnessThreadState(stateAdapter, testCase.events);
    await cleanupMcpAuthState(
      authRequesterUsers,
      autoCompleteMcpOauthProviders,
    );
    await cleanupOAuthTokens(authRequesterUsers, autoCompleteOauthProviders);
    (bot as unknown as { getAdapter?: (name: string) => unknown }).getAdapter =
      originalGetAdapter;
    if (originalJuniorBaseUrl === undefined) {
      delete process.env.JUNIOR_BASE_URL;
    } else {
      process.env.JUNIOR_BASE_URL = originalJuniorBaseUrl;
    }
    if (originalPluginPackages === undefined) {
      delete process.env.JUNIOR_PLUGIN_PACKAGES;
    } else {
      process.env.JUNIOR_PLUGIN_PACKAGES = originalPluginPackages;
    }
    if (originalSlackBotToken === undefined) {
      delete process.env.SLACK_BOT_TOKEN;
    } else {
      process.env.SLACK_BOT_TOKEN = originalSlackBotToken;
    }
    if (originalStateAdapter === undefined) {
      delete process.env.JUNIOR_STATE_ADAPTER;
    } else {
      process.env.JUNIOR_STATE_ADAPTER = originalStateAdapter;
    }
    if (testCase.behavior?.enable_test_credentials) {
      if (originalEnableTestCredentials === undefined) {
        delete process.env.EVAL_ENABLE_TEST_CREDENTIALS;
      } else {
        process.env.EVAL_ENABLE_TEST_CREDENTIALS =
          originalEnableTestCredentials;
      }
      if (originalTestCredentialToken === undefined) {
        delete process.env.EVAL_TEST_CREDENTIAL_TOKEN;
      } else {
        process.env.EVAL_TEST_CREDENTIAL_TOKEN = originalTestCredentialToken;
      }
    }
  }

  const posts = [...threadsById.values()].flatMap((thread) =>
    thread.posts.map(toPostedText),
  );
  const { channelPosts: capturedChannelPosts, reactions } =
    collectSlackArtifactsFromCapturedCalls(readCapturedSlackApiCalls());
  const channelPosts = [...capturedChannelPosts];
  for (const post of resumedChannelPosts) {
    if (
      channelPosts.some(
        (existing) =>
          existing.channel === post.channel &&
          existing.text === post.text &&
          existing.thread_ts === post.thread_ts,
      )
    ) {
      continue;
    }
    channelPosts.push(post);
  }

  return {
    channelPosts,
    reactions,
    posts,
    slackAdapter,
  };
}

// Compile-time guards for Thread and Message fakes are in tests/fixtures/slack-harness.ts.
// The toIncomingMessage function below still needs a local check since it maps from eval-specific fixtures.
type AssertAssignable<_TSub extends TSuper, TSuper> = true;
type _MessageCheck = AssertAssignable<
  ReturnType<typeof toIncomingMessage>,
  Pick<
    Message,
    "id" | "text" | "isMention" | "attachments" | "metadata" | "author"
  >
>;
