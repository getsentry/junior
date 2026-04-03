import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Message } from "chat";
import { createSlackRuntime } from "@/chat/app/factory";
import type { AssistantLifecycleEvent } from "@/chat/runtime/slack-runtime";
import type { JuniorRuntimeServiceOverrides } from "@/chat/app/services";
import { createUserTokenStore } from "@/chat/capabilities/factory";
import type { EmittedLogRecord } from "@/chat/logging";
import { determineThreadMessageKind } from "@/chat/ingress/message-router";
import {
  createThreadMessageDispatcher,
  type ThreadMessageKind,
} from "@/chat/queue/thread-message-dispatcher";
import {
  deleteMcpAuthSessionsForUserProvider,
  deleteMcpServerSessionId,
  deleteMcpStoredOAuthCredentials,
  getLatestMcpAuthSessionForUserProvider,
} from "@/chat/mcp/auth-store";
import { setPluginPackages } from "@/chat/plugins/package-discovery";
import { getPluginOAuthConfig } from "@/chat/plugins/registry";
import { generateAssistantReply } from "@/chat/respond";
import { getStateAdapter } from "@/chat/state/adapter";
import { resetSkillDiscoveryCache } from "@/chat/skills";
import {
  FakeSlackAdapter,
  createTestThread,
  type TestThread,
} from "@junior-tests/fixtures/slack-harness";
import {
  EVAL_OAUTH_CODE,
  EVAL_OAUTH_PROVIDER,
} from "@junior-tests/msw/handlers/eval-oauth";
import {
  EVAL_MCP_AUTH_CODE,
  EVAL_MCP_AUTH_PROVIDER,
} from "@junior-tests/msw/handlers/eval-mcp-auth";
import { runMcpOauthCallbackRoute } from "@junior-tests/fixtures/mcp-oauth-callback-harness";
import { runOauthCallbackRoute } from "@junior-tests/fixtures/oauth-callback-harness";
import {
  readCapturedSlackApiCalls,
  type CapturedSlackApiCall,
} from "@junior-tests/msw/captured-slack-api-calls";
import { createMockImageGenerateDeps } from "./fixtures/image-generate";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

interface EvalEventThreadFixture {
  channel_id?: string;
  id: string;
  run_id?: string;
  thread_ts?: string;
}

interface EvalEventMessageFixture {
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

interface EvalBaseEvent {
  thread: EvalEventThreadFixture;
}

interface MentionEvent extends EvalBaseEvent {
  message: EvalEventMessageFixture;
  type: "new_mention";
}

interface SubscribedMessageEvent extends EvalBaseEvent {
  message: EvalEventMessageFixture;
  type: "subscribed_message";
}

interface AssistantThreadStartedEvent extends EvalBaseEvent {
  type: "assistant_thread_started";
  user_id?: string;
}

interface AssistantContextChangedEvent extends EvalBaseEvent {
  type: "assistant_context_changed";
  user_id?: string;
}

export type EvalEvent =
  | MentionEvent
  | SubscribedMessageEvent
  | AssistantThreadStartedEvent
  | AssistantContextChangedEvent;

interface SubscribedDecisionFixture {
  reason: string;
  should_reply: boolean;
}

export interface EvalOverrides {
  auto_complete_mcp_oauth?: string[];
  auto_complete_oauth?: string[];
  enable_test_credentials?: boolean;
  fail_reply_call?: number;
  mock_image_generation?: boolean;
  plugin_dirs?: string[];
  plugin_packages?: string[];
  reply_texts?: string[];
  skill_dirs?: string[];
  subscribed_decisions?: SubscribedDecisionFixture[];
  test_credential_token?: string;
  unset_gateway_api_key?: boolean;
}

export interface EvalScenario {
  events: EvalEvent[];
  overrides?: EvalOverrides;
}

interface EvalScenarioRunOptions {
  logRecords?: EmittedLogRecord[];
}

export interface EvalResult {
  channelPosts: Array<{
    channel: string;
    text: string;
    thread_ts?: string;
  }>;
  logRecords: EmittedLogRecord[];
  posts: EvalAssistantPost[];
  reactions: Array<{
    channel: string;
    emoji: string;
    timestamp: string;
  }>;
  slackAdapter: FakeSlackAdapter;
}

export interface EvalAttachedFile {
  filename: string;
  isImage: boolean;
  mimeType?: string;
  sizeBytes?: number;
}

export interface EvalAssistantPost {
  files: EvalAttachedFile[];
  text: string;
}

interface EvalSlackThreadReply {
  bot_id?: string;
  text?: string;
  thread_ts?: string;
  ts?: string;
  user?: string;
}

interface EvalThreadRecord {
  thread: TestThread;
  transcript: Message[];
}

interface QueueDelivery {
  kind: ThreadMessageKind;
  message: Message;
  thread: TestThread;
}

// ---------------------------------------------------------------------------
// Internal constants and small helpers
// ---------------------------------------------------------------------------

const EVAL_PACKAGE_ROOT = path.resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);
type HarnessStateAdapter = ReturnType<typeof getStateAdapter>;

const THREAD_STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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

function buildRuntimeThreadId(fixture: EvalEventThreadFixture): string {
  if (fixture.channel_id && fixture.thread_ts) {
    return `slack:${fixture.channel_id}:${fixture.thread_ts}`;
  }
  return fixture.id;
}

// ---------------------------------------------------------------------------
// Environment snapshot helper
// ---------------------------------------------------------------------------

const HARNESS_ENV_KEYS = [
  "EVAL_ENABLE_TEST_CREDENTIALS",
  "EVAL_TEST_CREDENTIAL_TOKEN",
  "JUNIOR_BASE_URL",
  "JUNIOR_EXTRA_PLUGIN_ROOTS",
  "JUNIOR_STATE_ADAPTER",
  "SLACK_BOT_TOKEN",
] as const;

interface EnvSnapshot {
  restore(): void;
}

function snapshotEnv(keys: readonly string[]): EnvSnapshot {
  const saved = new Map<string, string | undefined>();
  for (const key of keys) {
    saved.set(key, process.env[key]);
  }
  return {
    restore() {
      for (const [key, value] of saved) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Thread / message helpers
// ---------------------------------------------------------------------------

function attachTranscriptAccessors(
  thread: TestThread,
  transcript: Message[],
): void {
  Object.defineProperty(thread, "recentMessages", {
    configurable: true,
    enumerable: true,
    get() {
      return [...transcript];
    },
  });
  Object.defineProperty(thread, "messages", {
    configurable: true,
    enumerable: true,
    get() {
      return (async function* () {
        for (const message of [...transcript].reverse()) {
          yield message;
        }
      })();
    },
  });
}

async function cleanupHarnessThreadState(
  stateAdapter: HarnessStateAdapter,
  events: readonly EvalEvent[],
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
    await stateAdapter.unsubscribe(threadId);
  }
  for (const channelId of channelIds) {
    await stateAdapter.delete(`channel-state:${channelId}`);
  }
}

function createEvalThread(args: {
  fixture: EvalEventThreadFixture;
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
  const originalSubscribe = thread.subscribe.bind(thread);
  thread.subscribe = async () => {
    await originalSubscribe();
    await args.stateAdapter.subscribe(thread.id);
  };
  const originalUnsubscribe = thread.unsubscribe.bind(thread);
  thread.unsubscribe = async () => {
    await originalUnsubscribe();
    await args.stateAdapter.unsubscribe(thread.id);
  };
  thread.isSubscribed = async () =>
    await args.stateAdapter.isSubscribed(thread.id);
  return thread;
}

function buildReactionKey(input: {
  channel: string;
  emoji: string;
  timestamp: string;
}): string {
  return `${input.channel}:${input.timestamp}:${input.emoji}`;
}

function toEvalFiles(value: unknown): EvalAttachedFile[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const files = (value as { files?: unknown }).files;
  if (!Array.isArray(files) || files.length === 0) {
    return [];
  }

  return files.map((file) => {
    if (!file || typeof file !== "object") {
      return {
        filename: "file",
        isImage: false,
      };
    }
    const filename =
      (typeof (file as { filename?: unknown }).filename === "string"
        ? (file as { filename: string }).filename
        : undefined) ??
      (typeof (file as { name?: unknown }).name === "string"
        ? (file as { name: string }).name
        : undefined) ??
      "file";
    const mediaType =
      (typeof (file as { mimeType?: unknown }).mimeType === "string"
        ? (file as { mimeType: string }).mimeType
        : undefined) ??
      (typeof (file as { mediaType?: unknown }).mediaType === "string"
        ? (file as { mediaType: string }).mediaType
        : undefined);
    const data =
      (file as { data?: unknown }).data instanceof Buffer
        ? (file as { data: Buffer }).data
        : undefined;
    return {
      filename,
      isImage: Boolean(mediaType?.startsWith("image/")),
      ...(mediaType ? { mimeType: mediaType } : {}),
      ...(data ? { sizeBytes: data.byteLength } : {}),
    };
  });
}

export function collectSlackArtifactsFromCapturedCalls(
  calls: CapturedSlackApiCall[],
): Pick<EvalResult, "channelPosts" | "reactions"> {
  const channelPosts: EvalResult["channelPosts"] = [];
  const reactions = new Map<string, EvalResult["reactions"][number]>();

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
      const reaction = {
        channel,
        emoji,
        timestamp,
      };
      reactions.set(buildReactionKey(reaction), reaction);
      continue;
    }

    if (call.method === "reactions.remove") {
      const channel = toFirstString(call.params.channel);
      const emoji = toFirstString(call.params.name);
      const timestamp = toFirstString(call.params.timestamp);
      if (!channel || !emoji || !timestamp) {
        continue;
      }
      reactions.delete(
        buildReactionKey({
          channel,
          emoji,
          timestamp,
        }),
      );
    }
  }

  return {
    channelPosts,
    reactions: [...reactions.values()],
  };
}

function toEvalAssistantPost(value: unknown): EvalAssistantPost {
  if (typeof value === "string") {
    return {
      text: value,
      files: [],
    };
  }
  if (value && typeof value === "object") {
    const markdown = (value as { markdown?: unknown }).markdown;
    const files = toEvalFiles(value);
    if (typeof markdown === "string") {
      return { text: markdown, files };
    }
    const raw = (value as { raw?: unknown }).raw;
    if (typeof raw === "string") {
      return { text: raw, files };
    }
    return { text: "", files };
  }
  return {
    text: String(value),
    files: [],
  };
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

function upsertThreadTranscriptMessage(
  transcript: Message[],
  message: Message,
): void {
  const existingIndex = transcript.findIndex(
    (entry) => entry.id === message.id,
  );
  if (existingIndex >= 0) {
    transcript[existingIndex] = message;
    return;
  }
  transcript.push(message);
}

function buildThreadReplyFromMessage(
  threadTs: string | undefined,
  message: Message,
): EvalSlackThreadReply {
  return {
    ts: message.id,
    user: message.author.userId,
    text: message.text,
    thread_ts: threadTs,
    ...(message.author.isBot ? { bot_id: message.author.userId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Auth cleanup and auto-complete helpers
// ---------------------------------------------------------------------------

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
  const userTokenStore = createUserTokenStore();
  for (const provider of providers) {
    for (const userId of userIds) {
      await userTokenStore.delete(userId, provider);
    }
  }
}

function getDefaultAuthCode(
  type: "mcp-oauth" | "oauth",
  provider: string,
): string {
  if (type === "mcp-oauth" && provider === EVAL_MCP_AUTH_PROVIDER) {
    return EVAL_MCP_AUTH_CODE;
  }
  if (type === "oauth" && provider === EVAL_OAUTH_PROVIDER) {
    return EVAL_OAUTH_CODE;
  }
  throw new Error(
    `No default eval ${type} code configured for provider "${provider}"`,
  );
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

async function autoCompleteMcpOauth(args: {
  provider: string;
  requesterUserId: string;
  consumedSessions: Set<string>;
}): Promise<boolean> {
  const provider = args.provider.trim() || EVAL_MCP_AUTH_PROVIDER;
  const authSession = await getLatestMcpAuthSessionForUserProvider(
    args.requesterUserId,
    provider,
  );
  if (!authSession || args.consumedSessions.has(authSession.authSessionId)) {
    return false;
  }

  const response = await runMcpOauthCallbackRoute({
    provider,
    state: authSession.authSessionId,
    code: getDefaultAuthCode("mcp-oauth", provider),
  });
  if (response.status !== 200) {
    throw new Error(
      `MCP OAuth callback returned ${response.status}: ${await response.text()}`,
    );
  }
  args.consumedSessions.add(authSession.authSessionId);
  return true;
}

async function autoCompleteOauth(args: {
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
    code: getDefaultAuthCode("oauth", provider),
  });
  if (response.status !== 200) {
    throw new Error(
      `OAuth callback returned ${response.status}: ${await response.text()}`,
    );
  }
  args.consumedStates.add(state);
  return true;
}

// ---------------------------------------------------------------------------
// Phase 1 — Environment setup
// ---------------------------------------------------------------------------

interface HarnessEnvironment {
  authRequesterUsers: Set<string>;
  autoCompleteMcpOauthProviders: Set<string>;
  autoCompleteOauthProviders: Set<string>;
  configuredPluginDirs: string[];
  configuredSkillDirs: string[];
  envSnapshot: EnvSnapshot;
  stateAdapter: HarnessStateAdapter;
}

async function setupHarnessEnvironment(
  scenario: EvalScenario,
): Promise<HarnessEnvironment> {
  const envSnapshot = snapshotEnv(HARNESS_ENV_KEYS);

  const configuredSkillDirs =
    scenario.overrides?.skill_dirs?.map(resolveEvalRelativePath) ?? [];
  const configuredPluginDirs =
    scenario.overrides?.plugin_dirs?.map(resolveEvalRelativePath) ?? [];
  const autoCompleteMcpOauthProviders = new Set(
    scenario.overrides?.auto_complete_mcp_oauth?.map((p) => p.trim()) ?? [],
  );
  const autoCompleteOauthProviders = new Set(
    scenario.overrides?.auto_complete_oauth?.map((p) => p.trim()) ?? [],
  );
  const authRequesterUsers = new Set(
    scenario.events.flatMap((event) =>
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

  if (scenario.overrides?.enable_test_credentials) {
    process.env.EVAL_ENABLE_TEST_CREDENTIALS = "1";
    if (scenario.overrides.test_credential_token) {
      process.env.EVAL_TEST_CREDENTIAL_TOKEN =
        scenario.overrides.test_credential_token;
    }
  }
  process.env.JUNIOR_BASE_URL = "https://junior.example.com";
  process.env.JUNIOR_STATE_ADAPTER = "memory";
  process.env.JUNIOR_EXTRA_PLUGIN_ROOTS = JSON.stringify(configuredPluginDirs);
  setPluginPackages(scenario.overrides?.plugin_packages ?? []);

  const stateAdapter = getStateAdapter();
  await stateAdapter.connect();
  resetSkillDiscoveryCache();
  await cleanupHarnessThreadState(stateAdapter, scenario.events);
  await cleanupMcpAuthState(authRequesterUsers, autoCompleteMcpOauthProviders);
  await cleanupOAuthTokens(authRequesterUsers, autoCompleteOauthProviders);

  return {
    authRequesterUsers,
    autoCompleteMcpOauthProviders,
    autoCompleteOauthProviders,
    configuredPluginDirs,
    configuredSkillDirs,
    envSnapshot,
    stateAdapter,
  };
}

async function teardownHarnessEnvironment(
  scenario: EvalScenario,
  env: HarnessEnvironment,
): Promise<void> {
  resetSkillDiscoveryCache();
  await cleanupHarnessThreadState(env.stateAdapter, scenario.events);
  await cleanupMcpAuthState(
    env.authRequesterUsers,
    env.autoCompleteMcpOauthProviders,
  );
  await cleanupOAuthTokens(
    env.authRequesterUsers,
    env.autoCompleteOauthProviders,
  );
  env.envSnapshot.restore();
}

// ---------------------------------------------------------------------------
// Phase 2 — Runtime services
// ---------------------------------------------------------------------------

function buildRuntimeServices(
  scenario: EvalScenario,
  env: HarnessEnvironment,
  threadRecordsById: Map<string, EvalThreadRecord>,
): JuniorRuntimeServiceOverrides {
  const replyTexts = scenario.overrides?.reply_texts ?? [];
  const subscribedDecisions = scenario.overrides?.subscribed_decisions ?? [];
  const replyTimeoutMs = Number.parseInt(
    process.env.EVAL_AGENT_REPLY_TIMEOUT_MS ?? "45000",
    10,
  );
  let replyCallCount = 0;
  let decisionIndex = 0;
  const replyState = { successfulCount: 0 };

  const services: JuniorRuntimeServiceOverrides = {
    ...(subscribedDecisions.length > 0
      ? {
          subscribedReplyPolicy: {
            // The mock bypasses the generic Zod-typed `completeObject` signature
            // since we return a fixed fixture rather than parsing a schema.
            completeObject: async () => {
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
          },
        }
      : {}),
    replyExecutor: {
      generateAssistantReply: async (text, context) => {
        replyCallCount += 1;
        const mockImageGeneration = scenario.overrides?.mock_image_generation;
        if (scenario.overrides?.fail_reply_call === replyCallCount) {
          throw new Error(`forced reply failure on call ${replyCallCount}`);
        }
        const replyText = replyTexts[replyState.successfulCount];
        if (typeof replyText === "string") {
          replyState.successfulCount += 1;
          return {
            text: replyText,
            deliveryMode: "thread",
            deliveryPlan: {
              mode: "thread",
              postThreadText: true,
              attachFiles: "none",
            },
            diagnostics: {
              assistantMessageCount: 1,
              modelId: "eval-reply-text",
              outcome: "success",
              toolCalls: [],
              toolErrorCount: 0,
              toolResultCount: 0,
              usedPrimaryText: true,
            },
          };
        }

        const gatewaySnapshot = snapshotEnv([
          "AI_GATEWAY_API_KEY",
          "VERCEL_OIDC_TOKEN",
        ]);
        if (scenario.overrides?.unset_gateway_api_key) {
          delete process.env.AI_GATEWAY_API_KEY;
          delete process.env.VERCEL_OIDC_TOKEN;
        }
        let reply: Awaited<ReturnType<typeof generateAssistantReply>>;
        try {
          reply = await Promise.race([
            generateAssistantReply(text, {
              ...context,
              ...(env.configuredSkillDirs.length > 0
                ? { skillDirs: env.configuredSkillDirs }
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
          if (scenario.overrides?.unset_gateway_api_key) {
            gatewaySnapshot.restore();
          }
        }

        replyState.successfulCount += 1;
        return reply;
      },
    },
    visionContext: {
      listThreadReplies: async ({ channelId, threadTs, targetMessageTs }) => {
        const threadId = buildRuntimeThreadId({
          id: `slack:${channelId}:${threadTs}`,
          channel_id: channelId,
          thread_ts: threadTs,
        });
        const replies = (threadRecordsById.get(threadId)?.transcript ?? []).map(
          (message) => buildThreadReplyFromMessage(threadTs, message),
        );
        if (!targetMessageTs || targetMessageTs.length === 0) {
          return replies;
        }
        const targets = new Set(targetMessageTs);
        return replies.filter(
          (reply) => typeof reply.ts === "string" && targets.has(reply.ts),
        );
      },
    },
  };

  return services;
}

// ---------------------------------------------------------------------------
// Phase 3 — Event processing
// ---------------------------------------------------------------------------

async function processEvents(args: {
  scenario: EvalScenario;
  env: HarnessEnvironment;
  slackRuntime: ReturnType<typeof createSlackRuntime>;
  dispatch: ReturnType<typeof createThreadMessageDispatcher>;
  getThreadRecord: (fixture: EvalEventThreadFixture) => EvalThreadRecord;
  readyQueueDeliveries: QueueDelivery[];
}): Promise<void> {
  const {
    scenario,
    env,
    slackRuntime,
    dispatch,
    getThreadRecord,
    readyQueueDeliveries,
  } = args;

  const consumedOauthStates = new Set<string>();
  const consumedMcpAuthSessions = new Set<string>();

  const maybeAutoCompleteAuth = async (): Promise<void> => {
    for (const provider of env.autoCompleteMcpOauthProviders) {
      for (const requesterUserId of env.authRequesterUsers) {
        await autoCompleteMcpOauth({
          provider,
          requesterUserId,
          consumedSessions: consumedMcpAuthSessions,
        });
      }
    }
    for (const provider of env.autoCompleteOauthProviders) {
      await autoCompleteOauth({
        provider,
        consumedStates: consumedOauthStates,
      });
    }
  };

  const processNextDelivery = async (): Promise<boolean> => {
    const current = readyQueueDeliveries.shift();
    if (!current) {
      return false;
    }
    await dispatch({
      kind: current.kind,
      thread: current.thread,
      message: current.message,
    });
    return true;
  };

  const enqueueEvent = (event: MentionEvent | SubscribedMessageEvent): void => {
    const { thread, transcript } = getThreadRecord(event.thread);
    const message = toIncomingMessage(event) as unknown as Message;
    upsertThreadTranscriptMessage(transcript, message);
    const kind = determineThreadMessageKind({
      isDirectMessage: thread.id.startsWith("slack:D"),
      isMention: event.message.is_mention ?? event.type === "new_mention",
      isSubscribed: event.type === "subscribed_message",
    });
    if (!kind) {
      return;
    }
    readyQueueDeliveries.push({ kind, message, thread });
  };

  const runLifecycleEvent = async (
    event: AssistantThreadStartedEvent | AssistantContextChangedEvent,
  ): Promise<void> => {
    const lifecycleEvent: AssistantLifecycleEvent = {
      threadId: event.thread.id,
      channelId: event.thread.channel_id ?? "C_EVAL",
      threadTs: event.thread.thread_ts ?? "0",
      userId: event.user_id ?? "U-eval",
    };
    if (event.type === "assistant_thread_started") {
      await slackRuntime.handleAssistantThreadStarted(lifecycleEvent);
      return;
    }
    await slackRuntime.handleAssistantContextChanged(lifecycleEvent);
  };

  for (const event of scenario.events) {
    if (event.type === "new_mention" || event.type === "subscribed_message") {
      enqueueEvent(event);
    } else {
      await runLifecycleEvent(event);
    }
    await maybeAutoCompleteAuth();
    if (await processNextDelivery()) {
      await maybeAutoCompleteAuth();
    }
  }

  while (readyQueueDeliveries.length > 0) {
    const processed = await processNextDelivery();
    if (!processed) {
      break;
    }
    await maybeAutoCompleteAuth();
  }
}

// ---------------------------------------------------------------------------
// Phase 4 — Result collection
// ---------------------------------------------------------------------------

function collectResults(
  threadRecordsById: Map<string, EvalThreadRecord>,
  slackAdapter: FakeSlackAdapter,
  logRecords: EmittedLogRecord[],
): EvalResult {
  const posts = [...threadRecordsById.values()].flatMap((record) =>
    record.thread.posts.map(toEvalAssistantPost),
  );
  const { channelPosts, reactions } = collectSlackArtifactsFromCapturedCalls(
    readCapturedSlackApiCalls(),
  );

  return {
    channelPosts,
    logRecords,
    reactions,
    posts,
    slackAdapter,
  };
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export async function runEvalScenario(
  scenario: EvalScenario,
  options: EvalScenarioRunOptions = {},
): Promise<EvalResult> {
  const logRecords = options.logRecords ?? [];
  const env = await setupHarnessEnvironment(scenario);

  const slackAdapter = new FakeSlackAdapter();
  const threadRecordsById = new Map<string, EvalThreadRecord>();
  const readyQueueDeliveries: QueueDelivery[] = [];
  const channelStateById = new Map<
    string,
    { value: Record<string, unknown> }
  >();

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

  const getThreadRecord = (
    fixture: EvalEventThreadFixture,
  ): EvalThreadRecord => {
    const runtimeThreadId = buildRuntimeThreadId(fixture);
    const existing = threadRecordsById.get(runtimeThreadId);
    if (existing) return existing;
    const thread = createEvalThread({
      fixture,
      channelStateRef: getChannelStateRef(fixture.channel_id),
      stateAdapter: env.stateAdapter,
    });
    const transcript: Message[] = [];
    attachTranscriptAccessors(thread, transcript);
    const record = { thread, transcript };
    threadRecordsById.set(runtimeThreadId, record);
    return record;
  };

  const services = buildRuntimeServices(scenario, env, threadRecordsById);

  const slackRuntime = createSlackRuntime({
    getSlackAdapter: () => slackAdapter as any,
    services,
  });
  const dispatch = createThreadMessageDispatcher({ runtime: slackRuntime });

  try {
    await processEvents({
      scenario,
      env,
      slackRuntime,
      dispatch,
      getThreadRecord,
      readyQueueDeliveries,
    });
  } finally {
    await teardownHarnessEnvironment(scenario, env);
  }

  return collectResults(threadRecordsById, slackAdapter, logRecords);
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
