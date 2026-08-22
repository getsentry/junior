import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import type { SlackAdapter } from "@chat-adapter/slack";
import { Message as ChatMessage, ThreadImpl, type Message } from "chat";
import type {
  Destination,
  PluginRegistration,
} from "@sentry/junior-plugin-api";
import { executeWithReplay } from "vitest-evals/replay";
import type { JsonValue } from "vitest-evals/harness";
import {
  createFauxCore,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai/providers/faux";
import { createSlackRuntime } from "@/chat/app/factory";
import { botConfig } from "@/chat/config";
import { getConversationEventStore, getDb } from "@/chat/db";
import type { AssistantLifecycleEvent } from "@/chat/runtime/slack-runtime";
import type { JuniorRuntimeServiceOverrides } from "@/chat/app/services";
import { createUserTokenStore } from "@/chat/capabilities/factory";
import { parseOAuthStatePayload } from "@/chat/oauth-flow";
import type { EmittedLogRecord } from "@/chat/logging";
import {
  type ThreadMessageKind,
  determineThreadMessageKind,
} from "@/chat/ingress/message-router";
import {
  deleteMcpAuthSessionsForUserProvider,
  deleteMcpServerSessionId,
  deleteMcpStoredOAuthCredentials,
  getMcpAuthSession,
  getMcpStoredOAuthCredentials,
} from "@/chat/mcp/auth-store";
import { getPlugins, setPlugins } from "@/chat/plugins/agent-hooks";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import {
  defineJuniorPlugins,
  pluginCatalogConfigFromPluginSet,
} from "@/plugins";
import {
  runPluginJob,
  scheduleSessionCompletedPluginJobs,
} from "@/chat/plugins/job-runner";
import type { PluginJobMessage } from "@/chat/plugins/job-message";
import { buildSlackInboundMessage } from "@/chat/task-execution/slack-work";
import { appendAndEnqueueInboundMessage } from "@/chat/task-execution/store";
import { deleteConversationState } from "@/chat/task-execution/state";
import { executeAgentRun } from "@/chat/agent";
import { actorFromRun } from "@/chat/agent/types";
import { renderCurrentInstruction } from "@/chat/current-instruction";
import { standardModelId } from "@/chat/model-profile";
import type { PiMessage } from "@/chat/pi/messages";
import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { addAgentTurnUsage, type AgentTurnUsage } from "@/chat/usage";
import { runNextPausedTurn } from "@/chat/task-execution/paused-turn";
import { wakePausedTurn } from "@/chat/task-execution/turn-wake";
import { ACTIVE_TURN_COMPACTION_SUMMARY_PREFIX } from "@/chat/services/context-compaction-marker";
import { TURN_CONTEXT_TAG } from "@/chat/turn-context-tag";
import { listIncompleteScheduledRuns } from "@/chat/scheduled-tasks/runs";
import {
  readScheduledTask,
  saveScheduledTask,
} from "@/chat/scheduled-tasks/tasks";
import type { ScheduledTask } from "@/chat/scheduled-tasks/types";
import { githubPlugin } from "@sentry/junior-github";
import { memoryPlugin } from "@sentry/junior-memory";
import { sentryPlugin } from "@sentry/junior-sentry";
import { runPluginHeartbeats } from "@/chat/agent-dispatch/heartbeat";
import { runScheduledTaskHeartbeat } from "@/chat/scheduled-tasks/heartbeat";
import {
  buildDispatchRoutingContext,
  createAgentDispatchConversationWorker,
  createAgentDispatchWorkRouter,
} from "@/chat/agent-dispatch/work";
import {
  ConversationTurnLifecycleService,
  type ConversationTurnLifecycle,
} from "@/chat/conversations/turn-lifecycle";
import {
  getDispatchInputMessageId,
  getDispatchRecord,
} from "@/chat/agent-dispatch/store";
import { ingestResourceEvent } from "@/chat/resource-events/ingest";
import { createResourceEventSubscription } from "@/chat/resource-events/store";
import { ingestEventTasks } from "@/chat/event-tasks/ingest";
import { createEventTask } from "@/chat/event-tasks/store";
import type { EventTask } from "@/chat/event-tasks/types";
import { getStateAdapter } from "@/chat/state/adapter";
import { upsertTurnRecord } from "@/chat/task-execution/turn-cursor";
import { turnCursorKey } from "@/chat/task-execution/turn-cursor-keys";
import { resetSkillDiscoveryCache } from "@/chat/skills";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { projectTimedOutToolResult } from "@/chat/tool-support/timed-out-tool-result";
import { DEFAULT_MAX_CHARS, MAX_FETCH_CHARS } from "@/chat/tools/web/constants";
import { truncateWebFetchContent } from "@/chat/tools/web/fetch-content";
import { createWebFetchTool } from "@/chat/tools/web/fetch-tool";
import { createWebSearchTool } from "@/chat/tools/web/search";
import type {
  ToolHooks,
  WebFetchToolDeps,
  WebSearchToolDeps,
} from "@/chat/tools/types";
import {
  FakeSlackAdapter,
  createTestThread,
  type TestThread,
} from "@junior-tests/fixtures/slack-harness";
import {
  createConversationWorkQueueTestAdapter,
  type ConversationWorkQueueTestAdapter,
} from "@junior-tests/fixtures/conversation-work";
import {
  EVAL_OAUTH_CODE,
  EVAL_OAUTH_PROVIDER,
} from "@junior-tests/msw/handlers/eval-oauth";
import {
  EVAL_MCP_AUTHORIZATION_ENDPOINT,
  EVAL_MCP_AUTH_PROVIDER,
} from "@junior-tests/msw/handlers/eval-mcp-auth";
import { completeMcpOauthCallbackRoute } from "@junior-tests/fixtures/mcp-oauth-callback-harness";
import { runOauthCallbackRoute } from "@junior-tests/fixtures/oauth-callback-harness";
import {
  readCapturedSlackApiCalls,
  type CapturedSlackApiCall,
} from "@junior-tests/msw/captured-slack-api-calls";
import {
  TEST_BOT_USER_ID,
  TEST_USER_ID,
} from "@junior-tests/fixtures/slack/factories/ids";
import { createSlackDestination } from "@/chat/destination";
import { createSlackConversationWorker } from "@/chat/task-execution/slack-work";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import { normalizeGitHubResourceEvents } from "@sentry/junior-github/testing";
import { createMemoryAttachmentStorage } from "./fixtures/attachment-storage";
import { createMockImageGenerateDeps } from "./fixtures/image-generate";
import { parseSlackMrkdwnLinkUrl } from "./slack-link";
import { loadEvalPluginFixtures } from "./eval-plugin-fixtures";

interface NormalizedMessage {
  role: "system" | "user" | "assistant";
  content?: JsonValue;
  metadata?: Record<string, JsonValue>;
}

const EVAL_PLUGIN_JOB_DRAIN_TIMEOUT_MS = 5_000;

interface PendingEvalPluginJob {
  abort(): void;
  promise: Promise<void>;
}

const pendingEvalPluginJobs = new Set<PendingEvalPluginJob>();

async function processEvalPluginJob(
  message: PluginJobMessage,
): Promise<void> {
  const controller = new AbortController();
  let job!: PendingEvalPluginJob;
  const promise = runPluginJob(message, {
    signal: controller.signal,
  }).finally(() => {
    pendingEvalPluginJobs.delete(job);
  });
  job = {
    abort() {
      controller.abort(new Error("Eval plugin job cleanup aborted job"));
    },
    promise,
  };
  pendingEvalPluginJobs.add(job);
  await promise;
}

/** Drain plugin jobs started by the eval harness before shared state cleanup. */
export async function drainPendingEvalPluginJobs(): Promise<void> {
  if (pendingEvalPluginJobs.size === 0) {
    return;
  }
  const jobs = [...pendingEvalPluginJobs];
  for (const job of jobs) {
    job.abort();
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(jobs.map((job) => job.promise)),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(
            new Error(
              `Timed out waiting for ${jobs.length} eval plugin job(s) to settle`,
            ),
          );
        }, EVAL_PLUGIN_JOB_DRAIN_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

interface EvalEventThreadFixture {
  channel_type?: "channel" | "group" | "im" | "mpim";
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
  raw?: Record<string, unknown>;
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

/** Models Slack messages that arrive while the preceding agent run is active. */
export interface SteerEvent {
  events: Array<MentionEvent | SubscribedMessageEvent>;
  type: "steer";
}

interface AssistantThreadStartedEvent extends EvalBaseEvent {
  type: "assistant_thread_started";
  user_id?: string;
}

interface AssistantContextChangedEvent extends EvalBaseEvent {
  type: "assistant_context_changed";
  user_id?: string;
}

interface ScheduledTaskDueEvent extends EvalBaseEvent {
  type: "scheduled_task_due";
  credential_mode?: "creator" | "system";
  now_ms?: number;
  recurrence?: "daily" | "weekly" | "monthly" | "yearly";
  schedule?: string;
  schedule_kind?: "one_off" | "recurring";
  task_text: string;
  timezone?: string;
}

interface EventTaskMatchedEvent extends EvalBaseEvent {
  type: "event_task_matched";
  event_key: string;
  event_type: string;
  label: string;
  namespace: string;
  identifier: string;
  resource_type: string;
  task_text: string;
  trusted_summary: string;
  untrusted_text?: string;
}

interface GitHubWebhookEvent extends EvalBaseEvent {
  body: unknown;
  delivery_id: string;
  event_name: string;
  subscription: {
    events: string[];
    intent: string;
    label: string;
    identifier: string;
    resource_type: string;
  };
  type: "github_webhook";
}

export type EvalEvent =
  | MentionEvent
  | SubscribedMessageEvent
  | AssistantThreadStartedEvent
  | AssistantContextChangedEvent
  | ScheduledTaskDueEvent
  | EventTaskMatchedEvent
  | GitHubWebhookEvent;

type SlackMessageEvent = MentionEvent | SubscribedMessageEvent;

function isSlackMessageEvent(event: EvalEvent): event is SlackMessageEvent {
  return event.type === "new_mention" || event.type === "subscribed_message";
}

/** Events present before processing begins; multiple events form one Slack mailbox batch. */
export type InitialEvents =
  | []
  | [EvalEvent]
  | [SlackMessageEvent, SlackMessageEvent, ...SlackMessageEvent[]];

function scenarioEvents(scenario: EvalScenario): EvalEvent[] {
  return [
    ...scenario.initialEvents,
    ...(scenario.events ?? []).flatMap((event) =>
      event.type === "steer" ? event.events : [event],
    ),
  ];
}

interface SubscribedDecisionFixture {
  reason: string;
  should_reply: boolean;
}

/** Host image fixture exposed at one model-visible sandbox path. */
interface EvalViewImageFixture {
  path: string;
  source: string;
}

export interface EvalOverrides {
  active_turn_compaction?: {
    summary: string;
  };
  auto_complete_mcp_oauth?: string[];
  auto_complete_oauth?: string[];
  credential_providers?: Array<"github" | "sentry">;
  expired_oauth_tokens?: string[];
  github_resource_events?: boolean;
  mock_image_generation?: boolean;
  plugin_dirs?: string[];
  plugin_packages?: string[];
  reply_timeout_ms?: number;
  reply_texts?: string[];
  skill_dirs?: string[];
  subscribed_decisions?: SubscribedDecisionFixture[];
  timeout_resume?: {
    arguments: Record<string, JsonValue>;
    tool_name: string;
  };
  unset_gateway_api_key?: boolean;
  view_image_files?: EvalViewImageFixture[];
}

export interface EvalScenario {
  initialEvents: InitialEvents;
  events?: Array<EvalEvent | SteerEvent>;
  overrides?: EvalOverrides;
}

interface EvalScenarioRunOptions {
  logRecords?: EmittedLogRecord[];
  signal?: AbortSignal;
}

interface SteeringDelivery {
  deliver?: () => Promise<void>;
}

export interface EvalResult {
  canvases: EvalCanvasArtifact[];
  channelPosts: Array<{
    channel: string;
    text: string;
    thread_ts?: string;
  }>;
  /**
   * Runtime conversation ids that took a turn in this scenario. These are the
   * exact ids the durable SQL stores key on, so eval-layer assertions can read
   * history/messages back through the store ports for the same conversation.
   */
  conversationIds: string[];
  logRecords: EmittedLogRecord[];
  authorizationCompletions: AuthorizationCompletion[];
  posts: EvalAssistantPost[];
  reactions: Array<{
    channel: string;
    emoji: string;
    timestamp: string;
  }>;
  modelIds: string[];
  slackAdapter: FakeSlackAdapter;
  toolInvocations: EvalToolInvocation[];
  usage?: AgentTurnUsage;
}

type CollectedEvalResult = EvalResult & {
  sessionMessages: NormalizedMessage[];
};

export interface AuthorizationCompletion {
  credentialStored: true;
  delivery: "direct_message" | "ephemeral";
  kind: "mcp" | "plugin";
  provider: string;
  userId: string;
}

export interface EvalAttachedFile {
  filename: string;
  isImage: boolean;
  mimeType?: string;
  sizeBytes?: number;
}

export interface EvalAssistantPost {
  channel?: string;
  eventType?: "channel_post" | "thread_post";
  files: EvalAttachedFile[];
  text: string;
  thread_ts?: string;
}

export interface EvalCanvasArtifact {
  markdown: string;
  title: string;
}

export interface EvalToolInvocation {
  arguments?: Record<string, unknown>;
  tool: string;
  toolCallId?: string;
  bash_command?: string;
  completed?: boolean;
  error?: string;
  mcp_arguments?: Record<string, unknown>;
  mcp_tool_name?: string;
  ok?: boolean;
  result?: unknown;
  skill_name?: string;
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

interface RuntimeObservations {
  authorizationCompletions: AuthorizationCompletion[];
  modelIds: Set<string>;
  sessionMessages: NormalizedMessage[];
  toolInvocations: EvalToolInvocation[];
  usage?: AgentTurnUsage;
}

function createReplayWebFetchDeps(
  baseOverrides: ToolHooks["toolOverrides"],
): WebFetchToolDeps {
  const liveTool = createWebFetchTool({ toolOverrides: {} });

  return {
    execute: async (input) => {
      const requestedMaxChars = input.max_chars ?? DEFAULT_MAX_CHARS;
      const args: Record<string, JsonValue> = {
        url: input.url,
        max_chars: MAX_FETCH_CHARS,
      };

      const { result } = await executeWithReplay({
        toolName: "webFetch",
        args,
        context: null,
        execute: async (replayArgs) => {
          const url = replayArgs.url;
          const maxChars = replayArgs.max_chars;
          if (typeof url !== "string") {
            throw new Error("webFetch replay args missing url");
          }
          const input = {
            url,
            ...(typeof maxChars === "number" ? { max_chars: maxChars } : {}),
          };
          const output = baseOverrides?.webFetch?.execute
            ? await baseOverrides.webFetch.execute(input)
            : await liveTool.execute!(input, {
                experimental_context: undefined,
              });
          return output as JsonValue;
        },
        replay: {
          version: "web-fetch-v2",
          key: (replayArgs) => ({
            url: replayArgs.url,
          }),
        },
      });
      const parsed = juniorToolOutputSchema.parse(result);
      if (typeof parsed.content !== "string") {
        return parsed;
      }
      const limited = truncateWebFetchContent(
        parsed.content,
        requestedMaxChars,
      );
      return {
        ...parsed,
        content: limited.content,
        truncated: parsed.truncated === true || limited.truncated,
      };
    },
  };
}

function createReplayWebSearchDeps(
  baseOverrides: ToolHooks["toolOverrides"],
): WebSearchToolDeps {
  const liveTool = createWebSearchTool(botConfig.webSearchModelId, {
    execute: baseOverrides?.webSearch?.execute,
  });

  return {
    execute: async (input) => {
      const args: Record<string, JsonValue> = { query: input.query };
      if (input.max_results !== undefined) {
        args.max_results = input.max_results;
      }

      const { result } = await executeWithReplay({
        toolName: "webSearch",
        args,
        context: null,
        execute: async (replayArgs) => {
          const query = replayArgs.query;
          const maxResults = replayArgs.max_results;
          if (typeof query !== "string") {
            throw new Error("webSearch replay args missing query");
          }
          const output = await liveTool.execute!(
            {
              query,
              ...(typeof maxResults === "number"
                ? { max_results: maxResults }
                : {}),
            },
            { experimental_context: undefined },
          );
          return output as JsonValue;
        },
        replay: {
          version: "web-search-v1",
          key: (replayArgs) => ({
            query: replayArgs.query,
            max_results: replayArgs.max_results ?? null,
          }),
        },
      });
      return juniorToolOutputSchema.parse(result);
    },
  };
}

function toEvalToolInvocation(input: {
  params: Record<string, unknown>;
  toolCallId?: string;
  toolName: string;
}): EvalToolInvocation {
  const invocation: EvalToolInvocation = {
    tool: input.toolName,
    arguments: input.params,
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
  };

  if (input.toolName === "bash" && typeof input.params.command === "string") {
    invocation.bash_command = input.params.command.trim();
  }

  if (
    input.toolName === "loadSkill" &&
    typeof input.params.skill_name === "string"
  ) {
    invocation.skill_name = input.params.skill_name.trim();
  }

  if (
    input.toolName === "callMcpTool" &&
    typeof input.params.tool_name === "string"
  ) {
    invocation.mcp_tool_name = input.params.tool_name.trim();
    if (
      input.params.arguments &&
      typeof input.params.arguments === "object" &&
      !Array.isArray(input.params.arguments)
    ) {
      invocation.mcp_arguments = input.params.arguments as Record<
        string,
        unknown
      >;
    }
  }

  return invocation;
}

// ---------------------------------------------------------------------------
// Internal constants and small helpers
// ---------------------------------------------------------------------------

const EVAL_PACKAGE_ROOT = path.resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);
type HarnessStateAdapter = ReturnType<typeof getStateAdapter>;

const EVAL_SLACK_TEAM_ID = "TEVAL";

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

function createEvalDestination(
  thread: TestThread,
): Extract<Destination, { platform: "slack" }> {
  const destination = createSlackDestination({
    teamId: EVAL_SLACK_TEAM_ID,
    channelId: thread.channelId,
  });
  if (!destination || destination.platform !== "slack") {
    throw new Error("Eval Slack destination requires a Slack channel id");
  }
  return destination;
}

// ---------------------------------------------------------------------------
// Environment snapshot helper
// ---------------------------------------------------------------------------

const HARNESS_ENV_KEYS = [
  "GITHUB_APP_BOT_EMAIL",
  "GITHUB_APP_BOT_NAME",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_INSTALLATION_ID",
  "GITHUB_WEBHOOK_SECRET",
  "JUNIOR_BASE_URL",
  "JUNIOR_SECRET",
  "JUNIOR_STATE_ADAPTER",
  "SENTRY_CLIENT_ID",
  "SENTRY_CLIENT_SECRET",
  "SLACK_BOT_TOKEN",
] as const;
const DEFAULT_EVAL_BASE_URL = "https://junior.example.com";
const SENTRY_EVAL_SCOPE =
  "alerts:write event:write member:read org:read project:releases project:write team:write";
const DUMMY_GITHUB_APP_PRIVATE_KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
})
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();

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

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Eval reply aborted");
}

async function raceWithAbort<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  if (signal.aborted) {
    throw abortReason(signal);
  }
  let removeAbortListener = () => {};
  const abortPromise = new Promise<never>((_, reject) => {
    const handleAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", handleAbort, { once: true });
    removeAbortListener = () =>
      signal.removeEventListener("abort", handleAbort);
  });
  try {
    return await Promise.race([operation(), abortPromise]);
  } finally {
    removeAbortListener();
  }
}

function ensureHarnessBaseUrl(): void {
  process.env.JUNIOR_BASE_URL ??= DEFAULT_EVAL_BASE_URL;
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
  scenario: EvalScenario,
): Promise<void> {
  const events = scenarioEvents(scenario);
  const runtimeThreadIds = new Set(
    events.map((event) => buildRuntimeThreadId(event.thread)),
  );
  const turnCursorKeys = events
    .filter(
      (event): event is MentionEvent | SubscribedMessageEvent =>
        "message" in event,
    )
    .map((event) => {
      const messageId = event.message.id ?? "";
      const turnId = `turn_${messageId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
      return turnCursorKey(buildRuntimeThreadId(event.thread), turnId);
    });
  const channelIds = new Set(
    events
      .map((event) => event.thread.channel_id?.trim())
      .filter((value): value is string => Boolean(value)),
  );

  for (const threadId of runtimeThreadIds) {
    await deleteConversationState({
      conversationId: threadId,
      state: stateAdapter,
    });
    await stateAdapter.delete(`thread-state:${threadId}`);
    await stateAdapter.unsubscribe(threadId);
  }
  for (const key of turnCursorKeys) {
    await stateAdapter.delete(key);
  }
  for (const channelId of channelIds) {
    await stateAdapter.delete(`channel-state:${channelId}`);
  }
}

async function createEvalThread(args: {
  fixture: EvalEventThreadFixture;
  channelStateRef?: { value: Record<string, unknown> };
  observations: RuntimeObservations;
  stateAdapter: HarnessStateAdapter;
}): Promise<TestThread> {
  // createTestThread already seeds Junior adapter scratch; keep subscribe state
  // mirrored onto the shared adapter for mailbox-backed ingress.
  const thread = await createTestThread({
    id: buildRuntimeThreadId(args.fixture),
    channelId: args.fixture.channel_id,
    runId: args.fixture.run_id,
    threadTs: args.fixture.thread_ts,
    channelStateRef: args.channelStateRef,
  });
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
  const originalPost = thread.post.bind(thread);
  thread.post = async (message: Parameters<TestThread["post"]>[0]) => {
    const sent = await originalPost(message);
    recordAssistantPost(
      args.observations,
      thread,
      toEvalAssistantPost(thread.posts.at(-1)),
    );
    return sent;
  };
  return thread;
}

function recordUserMessage(
  observations: RuntimeObservations,
  event: MentionEvent | SubscribedMessageEvent,
): void {
  const author = event.message.author;
  const authorName =
    author?.full_name?.trim() ||
    author?.user_name?.trim() ||
    author?.user_id?.trim();
  observations.sessionMessages.push({
    role: "user",
    content: event.message.text ?? "",
    metadata: {
      event_type: event.type,
      ...(authorName ? { author_name: authorName } : {}),
      ...(event.thread.channel_id ? { channel: event.thread.channel_id } : {}),
      ...(event.thread.thread_ts ? { thread_ts: event.thread.thread_ts } : {}),
    },
  });
}

function recordAssistantPost(
  observations: RuntimeObservations,
  thread: TestThread,
  post: EvalAssistantPost,
): void {
  const attachmentSummary = post.files
    .map(
      (file) =>
        `[attached ${file.isImage ? "image" : "file"}: ${file.filename}]`,
    )
    .join("\n");
  const content = [post.text, attachmentSummary].filter(Boolean).join("\n");
  observations.sessionMessages.push({
    role: "assistant",
    content,
    metadata: {
      event_type: post.eventType ?? "thread_post",
      channel: thread.channelId,
      ...(thread.threadTs ? { thread_ts: thread.threadTs } : {}),
      files: post.files.map((file) => ({
        filename: file.filename,
        isImage: file.isImage,
        ...(file.mimeType ? { mimeType: file.mimeType } : {}),
        ...(file.sizeBytes !== undefined ? { sizeBytes: file.sizeBytes } : {}),
      })),
    },
  });
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

function isImageFilename(filename: string): boolean {
  const normalized = filename.toLowerCase();
  return (
    normalized.endsWith(".png") ||
    normalized.endsWith(".jpg") ||
    normalized.endsWith(".jpeg") ||
    normalized.endsWith(".gif") ||
    normalized.endsWith(".webp")
  );
}

function toEvalUploadedFiles(files: unknown): EvalAttachedFile[] {
  if (!Array.isArray(files) || files.length === 0) {
    return [];
  }

  return files.map((file) => {
    const fields = file as {
      filename?: unknown;
      mimeType?: unknown;
      mimetype?: unknown;
      name?: unknown;
      title?: unknown;
    };
    const filename =
      toFirstString(fields.title) ??
      toFirstString(fields.filename) ??
      toFirstString(fields.name) ??
      "file";
    const mediaType =
      toFirstString(fields.mimeType) ?? toFirstString(fields.mimetype);
    return {
      filename,
      isImage: Boolean(
        mediaType?.startsWith("image/") || isImageFilename(filename),
      ),
      ...(mediaType ? { mimeType: mediaType } : {}),
    };
  });
}

export function collectSlackArtifactsFromCapturedCalls(
  calls: CapturedSlackApiCall[],
): Pick<EvalResult, "canvases" | "channelPosts" | "reactions"> & {
  filePosts: EvalAssistantPost[];
} {
  const canvases: EvalResult["canvases"] = [];
  const channelPosts: EvalResult["channelPosts"] = [];
  const filePosts: EvalAssistantPost[] = [];
  const reactions = new Map<string, EvalResult["reactions"][number]>();

  for (const call of calls) {
    if (call.method === "canvases.create") {
      const title = toFirstString(call.params.title) ?? "";
      const documentContent =
        call.params.document_content &&
        typeof call.params.document_content === "object"
          ? (call.params.document_content as Record<string, unknown>)
          : undefined;
      const markdown = documentContent
        ? (toFirstString(documentContent.markdown) ?? "")
        : "";
      if (!title && markdown.length === 0) {
        continue;
      }
      canvases.push({
        title,
        markdown,
      });
      continue;
    }

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

    if (call.method === "files.completeUploadExternal") {
      const channel = toFirstString(call.params.channel_id);
      const files = toEvalUploadedFiles(call.params.files);
      if (!channel || files.length === 0) {
        continue;
      }
      const threadTs = toFirstString(call.params.thread_ts);
      filePosts.push({
        channel,
        eventType: threadTs ? "thread_post" : "channel_post",
        files,
        text: toFirstString(call.params.initial_comment) ?? "",
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
    canvases,
    channelPosts,
    filePosts,
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

/**
 * Build a Chat SDK Message for Slack ingress from a harness event.
 *
 * Synthetic Slack ingress keeps an empty formatted AST so plain text remains
 * the source of truth, matching mailbox restore and edited-message
 * construction elsewhere in Junior.
 */
function toSlackMessage(
  event: MentionEvent | SubscribedMessageEvent,
  threadId: string,
  dateSentMs: number = Date.now(),
): Message {
  // In Slack payloads, `ts` identifies the specific message while `thread_ts`
  // identifies the thread root. Fixtures provide unique `message.id` per
  // event, so prefer it for `raw.ts` to avoid collapsing all replies to the
  // same timestamp in multi-turn thread scenarios.
  const messageTs = event.message.id ?? event.thread.thread_ts;
  return new ChatMessage({
    id: event.message.id ?? "",
    threadId,
    text: event.message.text ?? "",
    isMention: event.message.is_mention,
    attachments: [],
    // Empty root keeps plain text authoritative for synthetic ingress.
    formatted: { type: "root", children: [] },
    metadata: { dateSent: new Date(dateSentMs), edited: false },
    raw: {
      ...(event.message.raw ?? {}),
      channel: event.thread.channel_id,
      ...(event.thread.channel_type
        ? { channel_type: event.thread.channel_type }
        : {}),
      team_id: EVAL_SLACK_TEAM_ID,
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
  });
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

function configureCredentialProviderEnv(
  providers: Set<"github" | "sentry">,
): void {
  if (providers.has("github")) {
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_INSTALLATION_ID = "67890";
    process.env.GITHUB_APP_PRIVATE_KEY = DUMMY_GITHUB_APP_PRIVATE_KEY;
    process.env.GITHUB_APP_BOT_NAME = "junior-eval";
    process.env.GITHUB_APP_BOT_EMAIL =
      "12345+junior-eval[bot]@users.noreply.github.com";
  }
  if (providers.has("sentry")) {
    process.env.SENTRY_CLIENT_ID = "eval-sentry-client-id";
    process.env.SENTRY_CLIENT_SECRET = "eval-sentry-client-secret";
  }
}

async function seedCredentialProviderTokens(input: {
  providers: Set<"github" | "sentry">;
  userIds: Iterable<string>;
}): Promise<void> {
  if (!input.providers.has("sentry")) {
    return;
  }

  const userTokenStore = createUserTokenStore();
  for (const userId of input.userIds) {
    await userTokenStore.set(userId, "sentry", {
      accessToken: "eval-sentry-access-token",
      refreshToken: "eval-sentry-refresh-token",
      expiresAt: Date.now() + 60 * 60 * 1000,
      scope: SENTRY_EVAL_SCOPE,
    });
  }
}

async function seedExpiredOAuthTokens(input: {
  providers: Set<string>;
  userIds: Iterable<string>;
}): Promise<void> {
  const userTokenStore = createUserTokenStore();
  for (const provider of input.providers) {
    if (provider !== EVAL_OAUTH_PROVIDER) {
      throw new Error(
        `No expired OAuth eval fixture for provider "${provider}"`,
      );
    }
    for (const userId of input.userIds) {
      await userTokenStore.set(userId, provider, {
        accessToken: "expired-eval-oauth-access-token",
        refreshToken: "eval-oauth-refresh-token",
        expiresAt: Date.now() - 1,
        scope: "read",
      });
    }
  }
}

function getDefaultOauthCode(provider: string): string {
  if (provider === EVAL_OAUTH_PROVIDER) {
    return EVAL_OAUTH_CODE;
  }
  throw new Error(
    `No default eval OAuth code configured for provider "${provider}"`,
  );
}

function findLatestOAuthStateFromSlackCalls(args: {
  authorizeEndpoint: string;
  consumedStates: Set<string>;
}):
  | {
      channelId?: string;
      delivery: "direct_message" | "ephemeral";
      recipientUserId?: string;
      state: string;
    }
  | undefined {
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
    const authLink = parseSlackMrkdwnLinkUrl(text);
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
      if (call.method === "chat.postEphemeral") {
        const recipientUserId = toFirstString(call.params.user);
        if (!recipientUserId) {
          throw new Error("OAuth ephemeral delivery did not include a user");
        }
        return { delivery: "ephemeral", recipientUserId, state };
      }
      const channel = toFirstString(call.params.channel);
      if (!channel?.startsWith("D")) {
        throw new Error(
          "OAuth authorization link was posted through chat.postMessage outside a direct message",
        );
      }
      const openCall = calls
        .slice(0, index)
        .reverse()
        .find((candidate) => candidate.method === "conversations.open");
      const recipientUserId = openCall
        ? toFirstString(openCall.params.users)
        : undefined;
      return {
        channelId: channel,
        delivery: "direct_message",
        ...(recipientUserId ? { recipientUserId } : {}),
        state,
      };
    }
  }
  return undefined;
}

function wasOAuthLinkDeliveredToUser(
  delivered: {
    channelId?: string;
    recipientUserId?: string;
  },
  expected: { channelId?: string; userId: string },
): boolean {
  return (
    delivered.recipientUserId === expected.userId ||
    (delivered.channelId !== undefined &&
      expected.channelId !== undefined &&
      delivered.channelId === expected.channelId)
  );
}

async function autoCompleteMcpOauth(args: {
  agentRunner: AgentRunner;
  completions: AuthorizationCompletion[];
  provider: string;
  consumedStates: Set<string>;
}): Promise<boolean> {
  const provider = args.provider.trim() || EVAL_MCP_AUTH_PROVIDER;
  if (provider !== EVAL_MCP_AUTH_PROVIDER) {
    throw new Error(
      `No MCP OAuth authorization endpoint configured for eval provider "${provider}"`,
    );
  }
  const delivered = findLatestOAuthStateFromSlackCalls({
    authorizeEndpoint: EVAL_MCP_AUTHORIZATION_ENDPOINT,
    consumedStates: args.consumedStates,
  });
  if (!delivered) {
    return false;
  }
  const authSession = await getMcpAuthSession(delivered.state);
  if (!authSession || authSession.provider !== provider) {
    throw new Error(
      `Delivered MCP OAuth state did not resolve to provider "${provider}"`,
    );
  }
  if (
    !wasOAuthLinkDeliveredToUser(delivered, {
      channelId: authSession.channelId,
      userId: authSession.userId,
    })
  ) {
    throw new Error(
      `MCP OAuth authorization link was delivered to ${delivered.recipientUserId} instead of ${authSession.userId}`,
    );
  }

  const response = await completeMcpOauthCallbackRoute({
    provider,
    authSessionId: delivered.state,
    agentRunner: args.agentRunner,
  });
  if (response.status !== 200) {
    throw new Error(
      `MCP OAuth callback returned ${response.status}: ${await response.text()}`,
    );
  }
  const credentials = await getMcpStoredOAuthCredentials(
    authSession.userId,
    provider,
  );
  if (!credentials?.tokens?.access_token) {
    throw new Error(
      `MCP OAuth callback completed without stored credentials for provider "${provider}"`,
    );
  }
  args.completions.push({
    credentialStored: true,
    delivery: delivered.delivery,
    kind: "mcp",
    provider,
    userId: authSession.userId,
  });
  args.consumedStates.add(delivered.state);
  return true;
}

async function autoCompleteOauth(args: {
  agentRunner: AgentRunner;
  completions: AuthorizationCompletion[];
  provider: string;
  consumedStates: Set<string>;
}): Promise<boolean> {
  const provider = args.provider.trim() || EVAL_OAUTH_PROVIDER;
  const providerConfig = pluginCatalogRuntime.getOAuthConfig(provider);
  if (!providerConfig) {
    throw new Error(`Unknown OAuth provider "${provider}" in eval harness`);
  }

  const delivered = findLatestOAuthStateFromSlackCalls({
    authorizeEndpoint: providerConfig.authorizeEndpoint,
    consumedStates: args.consumedStates,
  });
  if (!delivered) {
    return false;
  }
  const storedState = parseOAuthStatePayload(
    await getStateAdapter().get(`oauth-state:${delivered.state}`),
  );
  if (!storedState || storedState.provider !== provider) {
    throw new Error(
      `Delivered OAuth state did not resolve to provider "${provider}"`,
    );
  }
  if (
    !wasOAuthLinkDeliveredToUser(delivered, {
      channelId: storedState.channelId,
      userId: storedState.userId,
    })
  ) {
    throw new Error(
      `OAuth authorization link was delivered to ${delivered.recipientUserId} instead of ${storedState.userId}`,
    );
  }
  const response = await runOauthCallbackRoute({
    provider,
    state: delivered.state,
    code: getDefaultOauthCode(provider),
    agentRunner: args.agentRunner,
  });
  if (response.status !== 200) {
    throw new Error(
      `OAuth callback returned ${response.status}: ${await response.text()}`,
    );
  }
  const credentials = await createUserTokenStore().get(
    storedState.userId,
    provider,
  );
  if (!credentials?.accessToken) {
    throw new Error(
      `OAuth callback completed without stored credentials for provider "${provider}"`,
    );
  }
  args.completions.push({
    credentialStored: true,
    delivery: delivered.delivery,
    kind: "plugin",
    provider,
    userId: storedState.userId,
  });
  args.consumedStates.add(delivered.state);
  return true;
}

// ---------------------------------------------------------------------------
// Phase 1 — Environment setup
// ---------------------------------------------------------------------------

interface HarnessEnvironment {
  authActorUsers: Set<string>;
  autoCompleteMcpOauthProviders: Set<string>;
  autoCompleteOauthProviders: Set<string>;
  credentialProviders: Set<"github" | "sentry">;
  expiredOauthProviders: Set<string>;
  configuredSkillDirs: string[];
  envSnapshot: EnvSnapshot;
  stateAdapter: HarnessStateAdapter;
}

function runtimePluginsForScenario(
  scenario: EvalScenario,
): PluginRegistration[] {
  const packages = new Set(scenario.overrides?.plugin_packages ?? []);
  return [
    ...(packages.has("@sentry/junior-github")
      ? [githubPlugin({ appPermissions: { deployments: "read" } })]
      : []),
    ...(packages.has("@sentry/junior-memory") ? [memoryPlugin()] : []),
    ...(packages.has("@sentry/junior-sentry") ? [sentryPlugin()] : []),
  ];
}

async function setupHarnessEnvironment(
  scenario: EvalScenario,
  runtimePlugins: PluginRegistration[],
): Promise<HarnessEnvironment> {
  const envSnapshot = snapshotEnv(HARNESS_ENV_KEYS);

  try {
    const explicitSkillDirs =
      scenario.overrides?.skill_dirs?.map(resolveEvalRelativePath) ?? [];
    const configuredPluginDirs =
      scenario.overrides?.plugin_dirs?.map(resolveEvalRelativePath) ?? [];
    const pluginFixtures = loadEvalPluginFixtures(configuredPluginDirs);
    const configuredSkillDirs = [
      ...explicitSkillDirs,
      ...pluginFixtures.skillDirs,
    ];
    const autoCompleteMcpOauthProviders = new Set(
      scenario.overrides?.auto_complete_mcp_oauth?.map((p) => p.trim()) ?? [],
    );
    const autoCompleteOauthProviders = new Set(
      scenario.overrides?.auto_complete_oauth?.map((p) => p.trim()) ?? [],
    );
    const credentialProviders = new Set(
      scenario.overrides?.credential_providers ?? [],
    );
    const expiredOauthProviders = new Set(
      scenario.overrides?.expired_oauth_tokens?.map((provider) =>
        provider.trim(),
      ) ?? [],
    );
    const authActorUsers = new Set(
      scenarioEvents(scenario).flatMap((event) =>
        "message" in event
          ? [event.message.author?.user_id?.trim() || TEST_USER_ID]
          : "user_id" in event && event.user_id
            ? [event.user_id]
            : [],
      ),
    );
    if (authActorUsers.size === 0) {
      authActorUsers.add(TEST_USER_ID);
    }

    configureCredentialProviderEnv(credentialProviders);
    if (scenario.overrides?.github_resource_events) {
      process.env.GITHUB_WEBHOOK_SECRET = "eval-github-webhook-secret";
    } else {
      delete process.env.GITHUB_WEBHOOK_SECRET;
    }
    ensureHarnessBaseUrl();
    process.env.JUNIOR_SECRET = "junior-test-secret";
    const pluginConfig = pluginCatalogConfigFromPluginSet(
      defineJuniorPlugins([
        ...(scenario.overrides?.plugin_packages ?? []),
        ...runtimePlugins,
      ]),
    );
    pluginCatalogRuntime.setConfig({
      inlineManifests: [
        ...pluginFixtures.inlineManifests,
        ...(pluginConfig?.inlineManifests ?? []),
      ],
      packages: pluginConfig?.packages ?? [],
    });

    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    resetSkillDiscoveryCache();
    await cleanupHarnessThreadState(stateAdapter, scenario);
    await cleanupMcpAuthState(authActorUsers, autoCompleteMcpOauthProviders);
    await cleanupOAuthTokens(authActorUsers, autoCompleteOauthProviders);
    await cleanupOAuthTokens(authActorUsers, credentialProviders);
    await cleanupOAuthTokens(authActorUsers, expiredOauthProviders);
    await seedCredentialProviderTokens({
      providers: credentialProviders,
      userIds: authActorUsers,
    });
    await seedExpiredOAuthTokens({
      providers: expiredOauthProviders,
      userIds: authActorUsers,
    });

    return {
      authActorUsers,
      autoCompleteMcpOauthProviders,
      autoCompleteOauthProviders,
      credentialProviders,
      expiredOauthProviders,
      configuredSkillDirs,
      envSnapshot,
      stateAdapter,
    };
  } catch (error) {
    resetSkillDiscoveryCache();
    pluginCatalogRuntime.setConfig(undefined);
    envSnapshot.restore();
    throw error;
  }
}

async function teardownHarnessEnvironment(
  scenario: EvalScenario,
  env: HarnessEnvironment,
): Promise<void> {
  resetSkillDiscoveryCache();
  pluginCatalogRuntime.setConfig(undefined);
  await cleanupHarnessThreadState(env.stateAdapter, scenario);
  await cleanupMcpAuthState(
    env.authActorUsers,
    env.autoCompleteMcpOauthProviders,
  );
  await cleanupOAuthTokens(env.authActorUsers, env.autoCompleteOauthProviders);
  await cleanupOAuthTokens(env.authActorUsers, env.credentialProviders);
  await cleanupOAuthTokens(env.authActorUsers, env.expiredOauthProviders);
  env.envSnapshot.restore();
}

// ---------------------------------------------------------------------------
// Phase 2 — Runtime services
// ---------------------------------------------------------------------------

function buildRuntimeServices(
  scenario: EvalScenario,
  env: HarnessEnvironment,
  threadRecordsById: Map<string, EvalThreadRecord>,
  observations: RuntimeObservations,
  conversationWorkQueue: ConversationWorkQueueTestAdapter,
  steeringDelivery: SteeringDelivery,
  turnLifecycle: ConversationTurnLifecycle,
  signal?: AbortSignal,
): JuniorRuntimeServiceOverrides {
  const replyTexts = scenario.overrides?.reply_texts ?? [];
  const subscribedDecisions = scenario.overrides?.subscribed_decisions ?? [];
  const replyTimeoutMs =
    scenario.overrides?.reply_timeout_ms &&
    scenario.overrides.reply_timeout_ms > 0
      ? scenario.overrides.reply_timeout_ms
      : Number.parseInt(process.env.EVAL_AGENT_REPLY_TIMEOUT_MS ?? "60000", 10);
  if (
    !Number.isInteger(replyTimeoutMs) ||
    replyTimeoutMs <= 0 ||
    replyTimeoutMs > 60_000
  ) {
    throw new Error(
      `Eval reply timeout must be an integer from 1 to 60000 milliseconds, got ${replyTimeoutMs}`,
    );
  }
  let decisionIndex = 0;
  const replyState = { successfulCount: 0 };
  let activeTurnCompactionInjected = false;
  let timeoutResumeInjected = false;
  // Match production agent runs: sendFiles stores durable attachment refs.
  const attachmentStorage = createMemoryAttachmentStorage();

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
      turnLifecycle,
      agentRunner: {
        run: async (request) => {
          const pendingSteeringDelivery = steeringDelivery.deliver;
          const runRequest = pendingSteeringDelivery
            ? {
                ...request,
                durability: {
                  ...request.durability,
                  onInputCommitted: async () => {
                    await request.durability?.onInputCommitted?.();
                    if (steeringDelivery.deliver !== pendingSteeringDelivery) {
                      return;
                    }
                    steeringDelivery.deliver = undefined;
                    await pendingSteeringDelivery();
                  },
                },
              }
            : request;
          const timeoutResume = scenario.overrides?.timeout_resume;
          const activeTurnCompaction =
            scenario.overrides?.active_turn_compaction;
          if (activeTurnCompaction && !activeTurnCompactionInjected) {
            activeTurnCompactionInjected = true;
            await runRequest.durability?.onInputCommitted?.();
            const nowMs = Date.now();
            const actor = actorFromRun(runRequest);
            const piMessages = [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: `<${TURN_CONTEXT_TAG}>\nEval continuation fixture.\n</${TURN_CONTEXT_TAG}>`,
                  },
                ],
                timestamp: nowMs,
              },
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: renderCurrentInstruction(runRequest.instruction.text),
                  },
                ],
                timestamp: nowMs + 1,
              },
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: `${ACTIVE_TURN_COMPACTION_SUMMARY_PREFIX}\n${activeTurnCompaction.summary}`,
                  },
                ],
                timestamp: nowMs + 2,
              },
            ] as PiMessage[];
            const sessionRecord = await upsertTurnRecord({
              conversationId: runRequest.conversationId,
              turnId: runRequest.turnId,
              sliceId: 1,
              state: "paused",
              piMessages,
              resumeReason: "yield",
              destination: runRequest.destination,
              destinationVisibility: runRequest.destinationVisibility,
              source: runRequest.source,
              surface: runRequest.surface,
              actor,
              trailingMessageProvenance: [
                { authority: "instruction", actor },
                { authority: "context" },
              ],
              turnStartMessageIndex: 0,
            });
            return {
              status: "suspended",
              reason: "yield" as const,
              resumeVersion: sessionRecord.version,
            };
          }
          if (timeoutResume && !timeoutResumeInjected) {
            timeoutResumeInjected = true;
            await runRequest.durability?.onInputCommitted?.();
            const nowMs = Date.now();
            const toolCallId = "eval-timeout-resume-tool-call";
            const abortedAttempt = {
              target: timeoutResume.tool_name,
              aborted: true,
            };
            const timedOutResult = projectTimedOutToolResult({
              content: [{ type: "text", text: JSON.stringify(abortedAttempt) }],
              details: abortedAttempt,
            });
            if (
              !timedOutResult?.content ||
              timedOutResult.details === undefined
            ) {
              throw new Error("Failed to build timeout continuation fixture");
            }
            const piMessages = [
              {
                role: "user",
                content: [{ type: "text", text: runRequest.instruction.text }],
                timestamp: nowMs,
              },
              {
                role: "assistant",
                content: [
                  {
                    type: "toolCall",
                    id: toolCallId,
                    name: timeoutResume.tool_name,
                    arguments: timeoutResume.arguments,
                  },
                ],
                stopReason: "toolUse",
                api: "eval-timeout-resume",
                provider: "eval-timeout-resume",
                model: "xai/grok-4.5",
                timestamp: nowMs,
                usage: { input: 0, output: 0, totalTokens: 0 },
              },
              {
                role: "toolResult",
                toolCallId,
                toolName: timeoutResume.tool_name,
                content: timedOutResult.content,
                details: timedOutResult.details,
                isError: timedOutResult.isError,
                timestamp: nowMs,
              },
            ] as PiMessage[];
            const sessionRecord = await upsertTurnRecord({
              conversationId: runRequest.conversationId,
              turnId: runRequest.turnId,
              sliceId: 2,
              state: "paused",
              piMessages,
              resumeReason: "timeout",
              resumedFromSliceId: 1,
              destination: runRequest.destination,
              destinationVisibility: runRequest.destinationVisibility,
              source: runRequest.source,
              surface: runRequest.surface,
              actor: actorFromRun(runRequest),
              errorMessage: "Agent turn timed out at the eval fixture boundary",
              turnStartMessageIndex: 0,
            });
            return {
              status: "suspended",
              reason: "timeout" as const,
              resumeVersion: sessionRecord.version,
            };
          }
          const mockImageGeneration = scenario.overrides?.mock_image_generation;
          const replyText = replyTexts[replyState.successfulCount];
          let scriptedStream: ReturnType<typeof createFauxCore> | undefined;
          if (typeof replyText === "string") {
            scriptedStream = createFauxCore({
              api: "eval",
              provider: "eval",
            });
            scriptedStream.setResponses([fauxAssistantMessage(replyText)]);
          }

          const gatewaySnapshot = snapshotEnv([
            "AI_GATEWAY_API_KEY",
            "VERCEL_OIDC_TOKEN",
          ]);
          const baseToolOverrides: ToolHooks["toolOverrides"] = {
            ...(request.environment?.toolOverrides ?? {}),
          };
          const viewImageFixtures = new Map(
            scenario.overrides?.view_image_files?.map((fixture) => [
              fixture.path,
              resolveEvalRelativePath(fixture.source),
            ]) ?? [],
          );
          const toolOverrides = {
            ...baseToolOverrides,
            webFetch: createReplayWebFetchDeps(baseToolOverrides),
            webSearch: createReplayWebSearchDeps(baseToolOverrides),
            ...(mockImageGeneration
              ? { imageGenerate: createMockImageGenerateDeps() }
              : {}),
            ...(viewImageFixtures.size > 0
              ? {
                  viewImage: {
                    readFile: async (imagePath: string) => {
                      const sourcePath = viewImageFixtures.get(imagePath);
                      return sourcePath ? await readFile(sourcePath) : null;
                    },
                  },
                }
              : {}),
          };
          if (scenario.overrides?.unset_gateway_api_key) {
            delete process.env.AI_GATEWAY_API_KEY;
            delete process.env.VERCEL_OIDC_TOKEN;
          }
          try {
            const pendingToolInvocations: EvalToolInvocation[] = [];
            const replySignal = AbortSignal.any([
              ...(signal ? [signal] : []),
              AbortSignal.timeout(replyTimeoutMs),
            ]);
            const outcome = await raceWithAbort(replySignal, () =>
              executeAgentRun(
                {
                  ...runRequest,
                  signal: replySignal,
                  deadlineAtMs: Math.min(
                    runRequest.deadlineAtMs ?? Number.POSITIVE_INFINITY,
                    Date.now() + replyTimeoutMs,
                  ),
                  environment: {
                    ...runRequest.environment,
                    attachmentStorage:
                      runRequest.environment?.attachmentStorage ??
                      attachmentStorage,
                    ...(env.configuredSkillDirs.length > 0
                      ? { skillDirs: env.configuredSkillDirs }
                      : {}),
                    toolOverrides,
                  },
                  onEvent: async (event) => {
                    await runRequest.onEvent?.(event);
                    if (event.type === "tool_started") {
                      const evalInvocation = toEvalToolInvocation({
                        params: event.params,
                        toolCallId: event.toolCallId,
                        toolName: event.toolName,
                      });
                      observations.toolInvocations.push(evalInvocation);
                      pendingToolInvocations.push(evalInvocation);
                      return;
                    }
                    if (event.type !== "tool_finished") {
                      return;
                    }
                    const result = event.report;
                    const pendingIndex = pendingToolInvocations.findIndex(
                      (candidate) => candidate.toolCallId === result.toolCallId,
                    );
                    if (pendingIndex === -1) {
                      return;
                    }
                    const [invocation] = pendingToolInvocations.splice(
                      pendingIndex,
                      1,
                    );
                    invocation.completed = true;
                    invocation.ok = result.ok;
                    if (result.error) {
                      invocation.error = result.error;
                    }
                    if (result.result !== undefined) {
                      invocation.result = result.result;
                    }
                  },
                },
                scriptedStream?.stream,
              ),
            );
            const usage =
              outcome.status === "completed"
                ? outcome.result.diagnostics.usage
                : outcome.usage;
            observations.usage = addAgentTurnUsage(observations.usage, usage);
            if (outcome.status === "completed") {
              observations.modelIds.add(outcome.result.diagnostics.modelId);
            }
            replyState.successfulCount += 1;
            return outcome;
          } finally {
            if (scenario.overrides?.unset_gateway_api_key) {
              gatewaySnapshot.restore();
            }
          }
        },
      },
      wakePausedTurn: async (request) => {
        await wakePausedTurn(request, {
          queue: conversationWorkQueue,
          state: env.stateAdapter,
        });
      },
      scheduleSessionCompletedPluginJobs: async (params) => {
        await scheduleSessionCompletedPluginJobs(params, {
          send: async (message) => {
            await processEvalPluginJob(message);
          },
        });
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
  agentRunner: AgentRunner;
  getSlackAdapter: () => FakeSlackAdapter;
  conversationWorkQueue: ConversationWorkQueueTestAdapter;
  slackRuntime: ReturnType<typeof createSlackRuntime>;
  getThreadRecord: (
    fixture: EvalEventThreadFixture,
  ) => Promise<EvalThreadRecord>;
  findEvalThread: (threadId: string) => TestThread | undefined;
  observations: RuntimeObservations;
  readyQueueDeliveries: QueueDelivery[];
  steeringDelivery: SteeringDelivery;
}): Promise<void> {
  const {
    scenario,
    env,
    agentRunner,
    getSlackAdapter,
    conversationWorkQueue,
    slackRuntime,
    getThreadRecord,
    findEvalThread,
    readyQueueDeliveries,
    steeringDelivery,
  } = args;

  const consumedOauthStates = new Set<string>();
  const consumedMcpOauthStates = new Set<string>();

  const maybeAutoCompleteAuth = async (): Promise<void> => {
    for (const provider of env.autoCompleteMcpOauthProviders) {
      await autoCompleteMcpOauth({
        agentRunner,
        completions: args.observations.authorizationCompletions,
        provider,
        consumedStates: consumedMcpOauthStates,
      });
    }
    for (const provider of env.autoCompleteOauthProviders) {
      await autoCompleteOauth({
        agentRunner,
        completions: args.observations.authorizationCompletions,
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
    const destination = createEvalDestination(current.thread);
    if (current.kind === "new_mention") {
      await slackRuntime.handleNewMention(current.thread, current.message, {
        destination,
      });
    } else {
      await slackRuntime.handleSubscribedMessage(
        current.thread,
        current.message,
        {
          destination,
        },
      );
    }
    return true;
  };

  // Deliver worker-claimed turns through the harness TestThread so replies
  // are captured like direct deliveries; the worker's restored thread has no
  // posting surface on the eval adapter.
  const workerRuntime: typeof slackRuntime = {
    ...slackRuntime,
    async handleNewMention(thread, message, hooks) {
      await slackRuntime.handleNewMention(
        findEvalThread(thread.id) ?? thread,
        message,
        hooks,
      );
    },
    async handleSubscribedMessage(thread, message, hooks) {
      await slackRuntime.handleSubscribedMessage(
        findEvalThread(thread.id) ?? thread,
        message,
        hooks,
      );
    },
  };

  const drainQueuedConversationWork = async (): Promise<void> => {
    const slackWorker = createSlackConversationWorker({
      getSlackAdapter: () => getSlackAdapter() as unknown as SlackAdapter,
      runNextPausedTurn: async (conversationId) =>
        await runNextPausedTurn(conversationId, {
          agentRunner,
          wakePausedTurn: async (request) => {
            await wakePausedTurn(request, {
              queue: conversationWorkQueue,
              state: env.stateAdapter,
            });
          },
          scheduleSessionCompletedPluginJobs: async (params) => {
            await scheduleSessionCompletedPluginJobs(params, {
              send: async (message) => {
                await processEvalPluginJob(message);
              },
            });
          },
        }),
      runtime: workerRuntime,
      state: env.stateAdapter,
    });
    const dispatchWorker = createAgentDispatchConversationWorker({
      resumeTurn: async (dispatch, hooks) => {
        await runNextPausedTurn(
          `agent-dispatch:${dispatch.id}`,
          {
            agentRunner,
            inputMessageIds: [getDispatchInputMessageId(dispatch.id)],
            routingContext: buildDispatchRoutingContext(dispatch),
            wakePausedTurn: async (request) => {
              await wakePausedTurn(request, {
                queue: conversationWorkQueue,
                state: env.stateAdapter,
              });
            },
            scheduleSessionCompletedPluginJobs: async (params) => {
              await scheduleSessionCompletedPluginJobs(params, {
                send: async (message) => {
                  await processEvalPluginJob(message);
                },
              });
            },
          },
          { shouldYield: hooks.shouldYield },
        );
      },
      runTurn: workerRuntime.runDispatchTurn,
    });
    let processed = 0;
    while (conversationWorkQueue.hasQueuedMessages()) {
      processed += 1;
      if (processed > 10) {
        throw new Error("Eval conversation work queue did not drain");
      }
      await processConversationQueueMessage(
        conversationWorkQueue.takeMessage(),
        {
          queue: conversationWorkQueue,
          run: createAgentDispatchWorkRouter({
            dispatchWorker,
            fallbackWorker: slackWorker,
          }),
          state: env.stateAdapter,
        },
      );
      await maybeAutoCompleteAuth();
    }
  };

  const appendMailboxMessages = async (
    events: Array<MentionEvent | SubscribedMessageEvent>,
  ): Promise<void> => {
    for (const [index, event] of events.entries()) {
      recordUserMessage(args.observations, event);
      const { thread, transcript } = await getThreadRecord(event.thread);
      const route =
        (event.message.is_mention ?? event.type === "new_mention")
          ? ("mention" as const)
          : ("subscribed" as const);
      const message = toSlackMessage(event, thread.id, Date.now() + index);
      upsertThreadTranscriptMessage(transcript, message);
      const ingressThread = new ThreadImpl({
        adapter: getSlackAdapter() as unknown as SlackAdapter,
        stateAdapter: env.stateAdapter,
        id: thread.id,
        channelId: thread.channelId,
        currentMessage: message,
        initialMessage: message,
        isDM: thread.id.startsWith("slack:D"),
        isSubscribedContext: route === "subscribed",
      });
      await appendAndEnqueueInboundMessage({
        message: buildSlackInboundMessage({
          conversationId: thread.id,
          installation: { teamId: EVAL_SLACK_TEAM_ID },
          message,
          receivedAtMs: Date.now(),
          route,
          thread: ingressThread,
        }),
        queue: conversationWorkQueue,
        state: env.stateAdapter,
      });
    }
  };

  const enqueueEvent = async (
    event: MentionEvent | SubscribedMessageEvent,
  ): Promise<void> => {
    recordUserMessage(args.observations, event);
    const { thread, transcript } = await getThreadRecord(event.thread);
    const message = toSlackMessage(event, thread.id);
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
      channelId: event.thread.channel_id ?? "CEVAL",
      threadTs: event.thread.thread_ts ?? "0",
      userId: event.user_id ?? "U-eval",
    };
    if (event.type === "assistant_thread_started") {
      await slackRuntime.handleAssistantThreadStarted(lifecycleEvent);
      return;
    }
    await slackRuntime.handleAssistantContextChanged(lifecycleEvent);
  };

  const runScheduledTaskDue = async (
    event: ScheduledTaskDueEvent,
  ): Promise<void> => {
    const { thread } = await getThreadRecord(event.thread);
    const nowMs = event.now_ms ?? Date.now();
    const scheduleKind = event.schedule_kind ?? "one_off";
    const taskId = `eval_schedule_${thread.channelId}_${nowMs}`;
    const task: ScheduledTask = {
      id: taskId,
      conversationAccess: { audience: "channel", visibility: "public" },
      createdAtMs: nowMs - 60_000,
      createdBy: { slackUserId: TEST_USER_ID, userName: "testuser" },
      creatorIdentityId: `eval:slack:${TEST_USER_ID}`,
      credentialMode: event.credential_mode ?? "system",
      destination: createEvalDestination(
        thread,
      ) as ScheduledTask["destination"],
      nextRunAtMs: nowMs,
      schedule: {
        description:
          event.schedule ??
          (scheduleKind === "recurring" ? "Weekly at noon" : "Once now"),
        kind: scheduleKind,
        timezone: event.timezone ?? "UTC",
        ...(scheduleKind === "recurring"
          ? {
              recurrence: {
                frequency: event.recurrence ?? "weekly",
                interval: 1,
                startDate: new Date(nowMs).toISOString().slice(0, 10),
                time: { hour: 12, minute: 0 },
              },
            }
          : {}),
      },
      status: "active",
      task: { text: event.task_text },
      updatedAtMs: nowMs - 60_000,
    };
    const db = getDb();
    await saveScheduledTask(db, task);

    await runScheduledTaskHeartbeat({
      conversationWorkQueue,
      nowMs,
    });

    const runs = (await listIncompleteScheduledRuns(db)).filter(
      (run) => run.taskId === taskId,
    );
    const dispatchedRuns = runs.filter((run) => run.dispatchId);
    if (dispatchedRuns.length === 0) {
      const savedTask = await readScheduledTask(db, taskId);
      throw new Error(
        `Scheduled eval task did not create a dispatch: ${JSON.stringify({ runs, savedTask })}`,
      );
    }
    for (const run of dispatchedRuns) {
      const dispatch = await getDispatchRecord(run.dispatchId!);
      if (!dispatch) {
        throw new Error("Scheduled eval dispatch record was not found.");
      }
      if (event.credential_mode === "creator") {
        const subject = dispatch.credentialSubject;
        if (
          !subject ||
          subject.type !== "user" ||
          subject.userId !== TEST_USER_ID ||
          subject.allowedWhen !== "scheduled-task" ||
          subject.taskId !== taskId ||
          subject.binding.type !== "scheduled-task" ||
          subject.binding.plugin !== "scheduler" ||
          subject.binding.taskId !== taskId
        ) {
          throw new Error(
            "Creator-bound scheduled eval dispatch did not use the task creator.",
          );
        }
      } else if (dispatch.credentialSubject) {
        throw new Error(
          "System scheduled eval dispatch unexpectedly used a user credential subject.",
        );
      }
    }
    await drainQueuedConversationWork();
  };

  const runGitHubWebhook = async (event: GitHubWebhookEvent): Promise<void> => {
    const { thread } = await getThreadRecord(event.thread);
    const nowMs = Date.now();
    await createResourceEventSubscription(
      {
        conversationId: thread.id,
        destination: createEvalDestination(thread),
        events: event.subscription.events,
        expiresAtMs: nowMs + 14 * 24 * 60 * 60 * 1000,
        intent: event.subscription.intent,
        label: event.subscription.label,
        namespace: "github",
        identifier: event.subscription.identifier,
        resourceType: event.subscription.resource_type,
      },
      { nowMs, state: env.stateAdapter },
    );
    const normalizedEvents = normalizeGitHubResourceEvents({
      body: event.body,
      deliveryId: event.delivery_id,
      eventName: event.event_name,
    });
    for (const normalizedEvent of normalizedEvents) {
      await ingestResourceEvent(
        { ...normalizedEvent, namespace: "github" },
        {
          nowMs,
          queue: conversationWorkQueue,
          state: env.stateAdapter,
          teamId: EVAL_SLACK_TEAM_ID,
        },
      );
    }
    await drainQueuedConversationWork();
  };

  const runEventTaskMatched = async (
    event: EventTaskMatchedEvent,
  ): Promise<void> => {
    const { thread } = await getThreadRecord(event.thread);
    const nowMs = Date.now();
    const taskId = `eval_event_task_${thread.channelId}_${nowMs}`;
    const task: EventTask = {
      id: taskId,
      createdAtMs: nowMs - 60_000,
      createdBy: { slackUserId: TEST_USER_ID, userName: "testuser" },
      credentialMode: "system",
      destination: createEvalDestination(thread),
      destinationVisibility: "public",
      task: { text: event.task_text },
      trigger: {
        events: [event.event_type],
        label: event.label,
        namespace: event.namespace,
        identifier: event.identifier,
        resourceType: event.resource_type,
      },
    };
    await createEventTask(getDb(), task);
    const result = await ingestEventTasks(
      {
        eventKey: event.event_key,
        eventType: event.event_type,
        occurredAtMs: nowMs,
        namespace: event.namespace,
        identifier: event.identifier,
        trustedSummary: event.trusted_summary,
        ...(event.untrusted_text
          ? { untrustedText: event.untrusted_text }
          : {}),
      },
      {
        nowMs,
        queue: conversationWorkQueue,
        teamId: task.destination.teamId,
      },
    );
    if (result.dispatched !== 1) {
      throw new Error(
        `Event task eval expected one dispatch, got ${result.dispatched}`,
      );
    }
    await drainQueuedConversationWork();
  };

  const processSettledEvent = async (event: EvalEvent): Promise<void> => {
    if (event.type === "new_mention" || event.type === "subscribed_message") {
      await enqueueEvent(event);
    } else if (event.type === "scheduled_task_due") {
      await runScheduledTaskDue(event);
    } else if (event.type === "event_task_matched") {
      await runEventTaskMatched(event);
    } else if (event.type === "github_webhook") {
      await runGitHubWebhook(event);
    } else {
      await runLifecycleEvent(event);
    }
    await maybeAutoCompleteAuth();
    if (await processNextDelivery()) {
      await maybeAutoCompleteAuth();
      await drainQueuedConversationWork();
    }
  };

  const processMessageGroup = async (
    messages: Array<MentionEvent | SubscribedMessageEvent>,
    steering?: SteerEvent,
  ): Promise<void> => {
    if (steering) {
      const conversationIds = new Set(
        [...messages, ...steering.events].map((event) =>
          buildRuntimeThreadId(event.thread),
        ),
      );
      if (conversationIds.size !== 1) {
        throw new Error(
          "steer() messages must target the preceding Slack conversation",
        );
      }
      steeringDelivery.deliver = async () => {
        await appendMailboxMessages(steering.events);
      };
    }
    await appendMailboxMessages(messages);
    await maybeAutoCompleteAuth();
    await drainQueuedConversationWork();
    if (steeringDelivery.deliver) {
      steeringDelivery.deliver = undefined;
      throw new Error(
        "steer() requires the preceding message group to start an agent run",
      );
    }
  };

  const remainingEvents = scenario.events ?? [];
  let nextIndex = 0;
  const initialSteering =
    remainingEvents[0]?.type === "steer" ? remainingEvents[0] : undefined;
  if (initialSteering) {
    nextIndex = 1;
  }

  const initialMessages = Array.from(scenario.initialEvents).filter(
    isSlackMessageEvent,
  );

  if (
    initialMessages.length > 0 &&
    initialMessages.length === scenario.initialEvents.length
  ) {
    await processMessageGroup(initialMessages, initialSteering);
  } else {
    if (scenario.initialEvents.length > 1 || initialSteering !== undefined) {
      throw new Error(
        "Multiple initialEvents and steer() require Slack message events",
      );
    }
    const initialEvent = scenario.initialEvents[0];
    if (initialEvent) {
      await processSettledEvent(initialEvent);
    }
  }

  while (nextIndex < remainingEvents.length) {
    const event = remainingEvents[nextIndex];
    if (!event) {
      break;
    }
    if (event.type === "steer") {
      throw new Error("steer() must follow a Slack message event");
    }
    const nextEvent = remainingEvents[nextIndex + 1];
    const steering = nextEvent?.type === "steer" ? nextEvent : undefined;
    if (steering) {
      if (event.type !== "new_mention" && event.type !== "subscribed_message") {
        throw new Error("steer() must follow a Slack message event");
      }
      await processMessageGroup([event], steering);
      nextIndex += 2;
      continue;
    }
    await processSettledEvent(event);
    nextIndex += 1;
  }

  while (readyQueueDeliveries.length > 0) {
    const processed = await processNextDelivery();
    if (!processed) {
      break;
    }
    await maybeAutoCompleteAuth();
    await drainQueuedConversationWork();
  }
}

// ---------------------------------------------------------------------------
// Phase 4 — Result collection
// ---------------------------------------------------------------------------

function collectResults(
  threadRecordsById: Map<string, EvalThreadRecord>,
  slackAdapter: FakeSlackAdapter,
  logRecords: EmittedLogRecord[],
  observations: RuntimeObservations,
): CollectedEvalResult {
  const threadReplyTargets = new Set(
    [...threadRecordsById.values()]
      .filter((record) => record.thread.threadTs)
      .map((record) => `${record.thread.channelId}:${record.thread.threadTs}`),
  );
  const { canvases, channelPosts, filePosts, reactions } =
    collectSlackArtifactsFromCapturedCalls(readCapturedSlackApiCalls());
  const threadPosts = [...threadRecordsById.values()].flatMap((record) =>
    record.thread.posts.map((post) => ({
      ...toEvalAssistantPost(post),
      channel: record.thread.channelId,
      ...(record.thread.threadTs ? { thread_ts: record.thread.threadTs } : {}),
    })),
  );
  const callbackThreadPosts = channelPosts
    .filter(
      (post) =>
        post.thread_ts &&
        threadReplyTargets.has(`${post.channel}:${post.thread_ts}`),
    )
    .map(
      (post): EvalAssistantPost => ({
        channel: post.channel,
        files: [],
        text: post.text,
        thread_ts: post.thread_ts,
      }),
    );

  return {
    canvases,
    channelPosts,
    conversationIds: [...threadRecordsById.keys()],
    logRecords,
    authorizationCompletions: observations.authorizationCompletions,
    reactions,
    modelIds: [...observations.modelIds],
    posts: [...threadPosts, ...callbackThreadPosts, ...filePosts],
    sessionMessages: observations.sessionMessages,
    slackAdapter,
    toolInvocations: observations.toolInvocations,
    ...(observations.usage ? { usage: observations.usage } : {}),
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
  const runtimePlugins = runtimePluginsForScenario(scenario);
  const env = await setupHarnessEnvironment(scenario, runtimePlugins);
  let previousPlugins: ReturnType<typeof setPlugins> | undefined;

  try {
    const runtimePluginNames = new Set(
      runtimePlugins.map((plugin) => plugin.manifest.name),
    );
    const currentPlugins = getPlugins();
    previousPlugins = setPlugins([
      ...runtimePlugins,
      ...currentPlugins.filter(
        (plugin) => !runtimePluginNames.has(plugin.manifest.name),
      ),
    ]);
    const slackAdapter = new FakeSlackAdapter({ botUserId: TEST_BOT_USER_ID });
    const threadRecordsById = new Map<string, EvalThreadRecord>();
    const readyQueueDeliveries: QueueDelivery[] = [];
    const observations: RuntimeObservations = {
      authorizationCompletions: [],
      modelIds: new Set(),
      sessionMessages: [],
      toolInvocations: [],
    };
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

    const getThreadRecord = async (
      fixture: EvalEventThreadFixture,
    ): Promise<EvalThreadRecord> => {
      const runtimeThreadId = buildRuntimeThreadId(fixture);
      const existing = threadRecordsById.get(runtimeThreadId);
      if (existing) return existing;
      const thread = await createEvalThread({
        fixture,
        channelStateRef: getChannelStateRef(fixture.channel_id),
        observations,
        stateAdapter: env.stateAdapter,
      });
      const transcript: Message[] = [];
      attachTranscriptAccessors(thread, transcript);
      const record = { thread, transcript };
      threadRecordsById.set(runtimeThreadId, record);
      return record;
    };

    const conversationWorkQueue = createConversationWorkQueueTestAdapter();
    const steeringDelivery: SteeringDelivery = {};
    const turnLifecycle = new ConversationTurnLifecycleService(
      getConversationEventStore(),
    );
    const services = buildRuntimeServices(
      scenario,
      env,
      threadRecordsById,
      observations,
      conversationWorkQueue,
      steeringDelivery,
      turnLifecycle,
      options.signal,
    );
    const evalAgentRunner = services.replyExecutor?.agentRunner;
    if (!evalAgentRunner) {
      throw new Error("Eval agent runner was not configured.");
    }

    const slackRuntime = createSlackRuntime({
      getSlackAdapter: () => slackAdapter as any,
      services,
    });

    await processEvents({
      scenario,
      env,
      agentRunner: evalAgentRunner,
      getSlackAdapter: () => slackAdapter,
      conversationWorkQueue,
      slackRuntime,
      getThreadRecord,
      findEvalThread: (threadId) => threadRecordsById.get(threadId)?.thread,
      observations,
      readyQueueDeliveries,
      steeringDelivery,
    });

    return collectResults(
      threadRecordsById,
      slackAdapter,
      logRecords,
      observations,
    );
  } finally {
    if (previousPlugins) {
      setPlugins(previousPlugins);
    }
    await teardownHarnessEnvironment(scenario, env);
  }
}

// Compile-time guards for Thread and Message fakes are in tests/fixtures/slack-harness.ts.
