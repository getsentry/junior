import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import type { SlackAdapter } from "@chat-adapter/slack";
import {
  Message as ChatMessage,
  ThreadImpl,
  type Message,
  type SerializedMessage,
} from "chat";
import type { Destination } from "@sentry/junior-plugin-api";
import {
  interceptTestHttp,
  resetTestGitHubHttpFixtures,
} from "@sentry/junior-testing/http";
import { executeWithReplay } from "vitest-evals/replay";
import type { JsonValue } from "vitest-evals/harness";
import {
  createPluginAppFixture,
  type PluginAppFixture,
} from "@junior-tests/fixtures/plugin-app";
import { createSlackRuntime } from "@/chat/app/factory";
import { getDb } from "@/chat/db";
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
  processPluginTask,
  scheduleSessionCompletedPluginTasks,
} from "@/chat/plugins/task-runner";
import type { PluginTaskQueueMessage } from "@/chat/plugins/task-message";
import { buildSlackInboundMessage } from "@/chat/task-execution/slack-work";
import { appendAndEnqueueInboundMessage } from "@/chat/task-execution/store";
import { executeAgentRun } from "@/chat/agent";
import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { resumeAwaitingSlackContinuation } from "@/chat/runtime/agent-continue-runner";
import { scheduleAgentContinue } from "@/chat/services/agent-continue";
import {
  createSchedulerSqlStore,
  schedulerPlugin,
  type ScheduledTask,
  type SchedulerDb,
} from "@sentry/junior-scheduler";
import { createMemoryPlugin } from "@sentry/junior-memory";
import { runPluginHeartbeats } from "@/chat/agent-dispatch/heartbeat";
import { runAgentDispatchSlice } from "@/chat/agent-dispatch/runner";
import { verifyDispatchCallbackRequest } from "@/chat/agent-dispatch/signing";
import { getDispatchRecord } from "@/chat/agent-dispatch/store";
import type { DispatchCallback } from "@/chat/agent-dispatch/types";
import { getStateAdapter } from "@/chat/state/adapter";
import { resetSkillDiscoveryCache } from "@/chat/skills";
import { juniorToolResultSchema } from "@/chat/tool-support/structured-result";
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
  EVAL_MCP_AUTH_CODE,
  EVAL_MCP_AUTHORIZATION_ENDPOINT,
  EVAL_MCP_AUTH_PROVIDER,
} from "@junior-tests/msw/handlers/eval-mcp-auth";
import { runMcpOauthCallbackRoute } from "@junior-tests/fixtures/mcp-oauth-callback-harness";
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
import { ALL as sandboxEgressProxyALL } from "@/handlers/sandbox-egress-proxy";
import { createMockImageGenerateDeps } from "./fixtures/image-generate";
import { parseSlackMrkdwnLinkUrl } from "./slack-link";

const EVAL_PLUGIN_TASK_DRAIN_TIMEOUT_MS = 5_000;

interface PendingEvalPluginTask {
  abort(): void;
  promise: Promise<void>;
}

const pendingEvalPluginTasks = new Set<PendingEvalPluginTask>();

async function processEvalPluginTask(
  message: PluginTaskQueueMessage,
): Promise<void> {
  const controller = new AbortController();
  let task!: PendingEvalPluginTask;
  const promise = processPluginTask(message, {
    signal: controller.signal,
  }).finally(() => {
    pendingEvalPluginTasks.delete(task);
  });
  task = {
    abort() {
      controller.abort(new Error("Eval plugin task cleanup aborted task"));
    },
    promise,
  };
  pendingEvalPluginTasks.add(task);
  await promise;
}

/** Drain plugin tasks started by the eval harness before shared state cleanup. */
export async function drainPendingEvalPluginTasks(): Promise<void> {
  if (pendingEvalPluginTasks.size === 0) {
    return;
  }
  const tasks = [...pendingEvalPluginTasks];
  for (const task of tasks) {
    task.abort();
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(tasks.map((task) => task.promise)),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(
            new Error(
              `Timed out waiting for ${tasks.length} eval plugin task(s) to settle`,
            ),
          );
        }, EVAL_PLUGIN_TASK_DRAIN_TIMEOUT_MS);
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

/**
 * Messages that are pending together in the conversation mailbox and are
 * handled as one worker turn: the last message becomes the live turn and the
 * earlier ones arrive as queued/skipped context, matching production mailbox
 * batching.
 */
interface MessageBatchEvent {
  events: Array<MentionEvent | SubscribedMessageEvent>;
  type: "message_batch";
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
  now_ms?: number;
  recurrence?: "daily" | "weekly" | "monthly" | "yearly";
  schedule?: string;
  schedule_kind?: "one_off" | "recurring";
  task_text: string;
  timezone?: string;
}

export type EvalEvent =
  | MentionEvent
  | SubscribedMessageEvent
  | MessageBatchEvent
  | AssistantThreadStartedEvent
  | AssistantContextChangedEvent
  | ScheduledTaskDueEvent;

/** Expand message batches so consumers can treat scenario events uniformly. */
function flattenEvalEvents(
  events: readonly EvalEvent[],
): Array<Exclude<EvalEvent, MessageBatchEvent>> {
  return events.flatMap((event) =>
    event.type === "message_batch" ? event.events : [event],
  );
}

interface SubscribedDecisionFixture {
  reason: string;
  should_reply: boolean;
}

interface EvalReplyResultFixture {
  assistant_message_count?: number;
  error_message?: string;
  outcome?: "success" | "execution_failure" | "provider_error";
  stop_reason?: string;
  stream_text?: string;
  text: string;
  tool_calls?: string[];
  tool_invocations?: EvalToolInvocation[];
  tool_error_count?: number;
  tool_result_count?: number;
  used_primary_text?: boolean;
}

export interface EvalOverrides {
  auto_complete_mcp_oauth?: string[];
  auto_complete_oauth?: string[];
  credential_providers?: Array<"github" | "sentry">;
  fail_reply_call?: number;
  mock_image_generation?: boolean;
  plugin_dirs?: string[];
  plugin_packages?: string[];
  reply_results?: EvalReplyResultFixture[];
  reply_timeout_ms?: number;
  reply_texts?: string[];
  skill_dirs?: string[];
  subscribed_decisions?: SubscribedDecisionFixture[];
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
  canvases: EvalCanvasArtifact[];
  channelPosts: Array<{
    channel: string;
    text: string;
    thread_ts?: string;
  }>;
  logRecords: EmittedLogRecord[];
  authorizationCompletions: AuthorizationCompletion[];
  posts: EvalAssistantPost[];
  reactions: Array<{
    channel: string;
    emoji: string;
    timestamp: string;
  }>;
  slackAdapter: FakeSlackAdapter;
  toolInvocations: EvalToolInvocation[];
}

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
  bash_command?: string;
  mcp_arguments?: Record<string, unknown>;
  mcp_tool_name?: string;
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
  toolInvocations: EvalToolInvocation[];
}

function createReplayWebFetchDeps(
  baseOverrides: ToolHooks["toolOverrides"],
): WebFetchToolDeps {
  const liveTool = createWebFetchTool({ toolOverrides: {} });

  return {
    execute: async (input) => {
      const args: Record<string, JsonValue> = { url: input.url };
      if (input.max_chars !== undefined) {
        args.max_chars = input.max_chars;
      }

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
          version: "web-fetch-v1",
          key: (replayArgs) => ({
            url: replayArgs.url,
            max_chars: replayArgs.max_chars ?? null,
          }),
        },
      });
      return juniorToolResultSchema.parse(result);
    },
  };
}

function createReplayWebSearchDeps(
  baseOverrides: ToolHooks["toolOverrides"],
): WebSearchToolDeps {
  const liveTool = createWebSearchTool({
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
      return juniorToolResultSchema.parse(result);
    },
  };
}

function toEvalToolInvocation(input: {
  toolName: string;
  params: Record<string, unknown>;
}): EvalToolInvocation {
  const invocation: EvalToolInvocation = {
    tool: input.toolName,
    arguments: input.params,
  };

  if (input.toolName.startsWith("slackSchedule")) {
    invocation.arguments = Object.fromEntries(
      [
        "task_id",
        "task",
        "schedule",
        "timezone",
        "next_run_at",
        "recurrence",
        "status",
      ]
        .filter((key) => key in input.params)
        .map((key) => [key, input.params[key]]),
    );
  }

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

const THREAD_STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
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

function createEvalDestination(thread: TestThread): Destination {
  const destination = createSlackDestination({
    teamId: EVAL_SLACK_TEAM_ID,
    channelId: thread.channelId,
  });
  if (!destination) {
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
  "JUNIOR_BASE_URL",
  "JUNIOR_SECRET",
  "JUNIOR_STATE_ADAPTER",
  "SLACK_BOT_TOKEN",
] as const;
const DEFAULT_EVAL_BASE_URL = "https://junior.example.com";
const SENTRY_EVAL_SCOPE = "event:read org:read project:read team:read";
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

function isSandboxReachableBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      hostname !== "localhost" &&
      hostname !== "127.0.0.1" &&
      hostname !== "::1" &&
      !hostname.endsWith(".example.com") &&
      !hostname.endsWith(".example.test") &&
      hostname !== "example.com"
    );
  } catch {
    return false;
  }
}

function scenarioNeedsEvalEgress(scenario: EvalScenario): boolean {
  return Boolean(
    scenario.overrides?.credential_providers?.length ||
    scenario.overrides?.auto_complete_oauth?.length,
  );
}

function configureHarnessBaseUrl(scenario: EvalScenario): void {
  const baseUrl = process.env.JUNIOR_BASE_URL?.trim();
  if (scenarioNeedsEvalEgress(scenario)) {
    if (!baseUrl || !isSandboxReachableBaseUrl(baseUrl)) {
      throw new Error(
        "Eval sandbox HTTP interception requires JUNIOR_BASE_URL to point at a public HTTPS Junior app URL reachable from Vercel Sandbox so sandbox egress can reach the test egress proxy.",
      );
    }
    return;
  }

  process.env.JUNIOR_BASE_URL = DEFAULT_EVAL_BASE_URL;
}

function requestHeadersFromNode(
  headers: Record<string, string | string[] | undefined>,
): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) result.append(key, item);
    } else {
      result.set(key, value);
    }
  }
  return result;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Eval egress server did not bind to a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function writeResponse(
  target: import("node:http").ServerResponse,
  response: Response,
): Promise<void> {
  target.statusCode = response.status;
  target.statusMessage = response.statusText;
  response.headers.forEach((value, key) => {
    target.setHeader(key, value);
  });

  if (!response.body) {
    target.end();
    return;
  }

  const reader = response.body.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      target.write(next.value);
    }
    target.end();
  } finally {
    reader.releaseLock();
  }
}

async function waitForPublicEgressUrl(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL("/health", baseUrl));
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Eval egress server was not reachable at ${baseUrl}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function startEvalEgressServer(): Promise<EvalEgressServer> {
  const baseUrl = process.env.JUNIOR_BASE_URL?.trim() ?? "";
  const token = process.env.CLOUDFLARE_TUNNEL_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "Eval sandbox HTTP interception requires CLOUDFLARE_TUNNEL_TOKEN so Vercel Sandbox can reach the eval egress proxy.",
    );
  }

  const server = createServer((incoming, outgoing) => {
    void (async () => {
      try {
        if (incoming.url === "/health") {
          outgoing.setHeader("content-type", "application/json");
          outgoing.end(JSON.stringify({ ok: true }));
          return;
        }

        const request = new Request(
          new URL(incoming.url ?? "/", `http://${incoming.headers.host}`).href,
          {
            method: incoming.method,
            headers: requestHeadersFromNode(incoming.headers),
            ...(incoming.method === "GET" || incoming.method === "HEAD"
              ? {}
              : {
                  body: incoming as unknown as BodyInit,
                  duplex: "half",
                }),
          } as RequestInit,
        );
        await writeResponse(
          outgoing,
          await sandboxEgressProxyALL(request, {
            interceptHttp: interceptTestHttp,
          }),
        );
      } catch (error) {
        console.error(
          "Eval egress server request failed",
          error instanceof Error ? error.message : String(error),
        );
        outgoing.statusCode = 500;
        outgoing.setHeader("content-type", "text/plain; charset=utf-8");
        outgoing.end("Eval egress server error\n");
      }
    })();
  });

  const port = await listen(server);
  let tunnel: ChildProcess | undefined;
  tunnel = spawn(
    "cloudflared",
    [
      "tunnel",
      "--no-autoupdate",
      "--loglevel",
      "warn",
      "--transport-loglevel",
      "error",
      "run",
      "--token",
      token,
      "--url",
      `http://127.0.0.1:${port}`,
    ],
    { stdio: "ignore" },
  );

  try {
    await waitForPublicEgressUrl(baseUrl);
  } catch (error) {
    tunnel.kill("SIGTERM");
    await closeServer(server);
    throw error;
  }

  return {
    async close() {
      tunnel?.kill("SIGTERM");
      await closeServer(server);
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
  scenarioEvents: readonly EvalEvent[],
): Promise<void> {
  const events = flattenEvalEvents(scenarioEvents);
  const runtimeThreadIds = new Set(
    events.map((event) => buildRuntimeThreadId(event.thread)),
  );
  const turnSessionKeys = events
    .filter(
      (event): event is MentionEvent | SubscribedMessageEvent =>
        "message" in event,
    )
    .map((event) => {
      const messageId = event.message.id ?? "";
      const sessionId = `turn_${messageId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
      return `junior:agent_turn_session:${buildRuntimeThreadId(event.thread)}:${sessionId}`;
    });
  const channelIds = new Set(
    events
      .map((event) => event.thread.channel_id?.trim())
      .filter((value): value is string => Boolean(value)),
  );

  for (const threadId of runtimeThreadIds) {
    await stateAdapter.delete(`thread-state:${threadId}`);
    await stateAdapter.unsubscribe(threadId);
  }
  for (const key of turnSessionKeys) {
    await stateAdapter.delete(key);
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
  };
}

/** Serialize an eval message fixture the way Slack ingress persists messages. */
function toSerializedSlackMessage(
  event: MentionEvent | SubscribedMessageEvent,
  threadId: string,
  dateSentMs: number,
): SerializedMessage {
  const incoming = toIncomingMessage(event);
  return {
    _type: "chat:Message",
    attachments: [],
    author: incoming.author,
    formatted: { type: "root", children: [] },
    id: incoming.id,
    isMention: incoming.isMention ?? false,
    metadata: { dateSent: new Date(dateSentMs).toISOString(), edited: false },
    raw: incoming.raw,
    text: incoming.text,
    threadId,
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

function configureCredentialProviderEnv(
  providers: Set<"github" | "sentry">,
): void {
  if (providers.has("github")) {
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_INSTALLATION_ID = "67890";
    process.env.GITHUB_APP_PRIVATE_KEY = DUMMY_GITHUB_APP_PRIVATE_KEY;
    process.env.GITHUB_APP_BOT_NAME = "junior-eval";
    process.env.GITHUB_APP_BOT_EMAIL = "junior-eval@example.com";
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

  const response = await runMcpOauthCallbackRoute({
    provider,
    state: delivered.state,
    code: getDefaultAuthCode("mcp-oauth", provider),
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
    code: getDefaultAuthCode("oauth", provider),
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
  configuredPluginDirs: string[];
  configuredSkillDirs: string[];
  envSnapshot: EnvSnapshot;
  egressServer?: EvalEgressServer;
  pluginApp?: PluginAppFixture;
  stateAdapter: HarnessStateAdapter;
}

interface EvalEgressServer {
  close(): Promise<void>;
}

async function setupHarnessEnvironment(
  scenario: EvalScenario,
): Promise<HarnessEnvironment> {
  const envSnapshot = snapshotEnv(HARNESS_ENV_KEYS);
  let egressServer: EvalEgressServer | undefined;
  let pluginApp: PluginAppFixture | undefined;

  try {
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
    const credentialProviders = new Set(
      scenario.overrides?.credential_providers ?? [],
    );
    const authActorUsers = new Set(
      flattenEvalEvents(scenario.events).flatMap((event) =>
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
    configureHarnessBaseUrl(scenario);
    process.env.JUNIOR_SECRET = "junior-test-secret";
    process.env.JUNIOR_STATE_ADAPTER = "memory";
    pluginApp =
      configuredPluginDirs.length > 0
        ? await createPluginAppFixture(configuredPluginDirs, {
            linkNodeModules: Boolean(
              scenario.overrides?.plugin_packages?.length,
            ),
          })
        : undefined;
    pluginCatalogRuntime.setConfig({
      packages: scenario.overrides?.plugin_packages ?? [],
    });

    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    egressServer = scenarioNeedsEvalEgress(scenario)
      ? await startEvalEgressServer()
      : undefined;
    resetSkillDiscoveryCache();
    resetTestGitHubHttpFixtures();
    await cleanupHarnessThreadState(stateAdapter, scenario.events);
    await cleanupMcpAuthState(authActorUsers, autoCompleteMcpOauthProviders);
    await cleanupOAuthTokens(authActorUsers, autoCompleteOauthProviders);
    await cleanupOAuthTokens(authActorUsers, credentialProviders);
    await seedCredentialProviderTokens({
      providers: credentialProviders,
      userIds: authActorUsers,
    });

    return {
      authActorUsers,
      autoCompleteMcpOauthProviders,
      autoCompleteOauthProviders,
      credentialProviders,
      configuredPluginDirs,
      configuredSkillDirs,
      envSnapshot,
      ...(egressServer ? { egressServer } : {}),
      ...(pluginApp ? { pluginApp } : {}),
      stateAdapter,
    };
  } catch (error) {
    resetSkillDiscoveryCache();
    pluginCatalogRuntime.setConfig(undefined);
    envSnapshot.restore();
    await egressServer?.close();
    await pluginApp?.cleanup();
    throw error;
  }
}

async function teardownHarnessEnvironment(
  scenario: EvalScenario,
  env: HarnessEnvironment,
): Promise<void> {
  resetSkillDiscoveryCache();
  pluginCatalogRuntime.setConfig(undefined);
  await cleanupHarnessThreadState(env.stateAdapter, scenario.events);
  await cleanupMcpAuthState(
    env.authActorUsers,
    env.autoCompleteMcpOauthProviders,
  );
  await cleanupOAuthTokens(env.authActorUsers, env.autoCompleteOauthProviders);
  await cleanupOAuthTokens(env.authActorUsers, env.credentialProviders);
  await env.egressServer?.close();
  env.envSnapshot.restore();
  await env.pluginApp?.cleanup();
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
): JuniorRuntimeServiceOverrides {
  const replyResults = scenario.overrides?.reply_results ?? [];
  const replyTexts = scenario.overrides?.reply_texts ?? [];
  const subscribedDecisions = scenario.overrides?.subscribed_decisions ?? [];
  const replyTimeoutMs =
    scenario.overrides?.reply_timeout_ms &&
    scenario.overrides.reply_timeout_ms > 0
      ? scenario.overrides.reply_timeout_ms
      : Number.parseInt(
          process.env.EVAL_AGENT_REPLY_TIMEOUT_MS ??
            (scenarioNeedsEvalEgress(scenario) ? "60000" : "30000"),
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
      agentRunner: {
        run: async (request) => {
          replyCallCount += 1;
          const mockImageGeneration = scenario.overrides?.mock_image_generation;
          if (scenario.overrides?.fail_reply_call === replyCallCount) {
            throw new Error(`forced reply failure on call ${replyCallCount}`);
          }
          const replyResult = replyResults[replyCallCount - 1];
          if (replyResult) {
            if (replyResult.stream_text) {
              await request.observers?.onTextDelta?.(replyResult.stream_text);
            }
            replyState.successfulCount += 1;
            observations.toolInvocations.push(
              ...(replyResult.tool_invocations ??
                (replyResult.tool_calls ?? []).map((tool) => ({ tool }))),
            );
            return completedAgentRun({
              text: replyResult.text,
              deliveryMode: "thread",
              deliveryPlan: {
                mode: "thread",
                postThreadText: true,
              },
              diagnostics: {
                assistantMessageCount: replyResult.assistant_message_count ?? 1,
                ...(replyResult.error_message
                  ? { errorMessage: replyResult.error_message }
                  : {}),
                modelId: "eval-reply-result",
                outcome: replyResult.outcome ?? "success",
                ...(replyResult.stop_reason
                  ? { stopReason: replyResult.stop_reason }
                  : {}),
                toolCalls: replyResult.tool_calls ?? [],
                toolErrorCount: replyResult.tool_error_count ?? 0,
                toolResultCount: replyResult.tool_result_count ?? 0,
                usedPrimaryText: replyResult.used_primary_text ?? true,
              },
            });
          }
          const replyText = replyTexts[replyState.successfulCount];
          if (typeof replyText === "string") {
            replyState.successfulCount += 1;
            return completedAgentRun({
              text: replyText,
              deliveryMode: "thread",
              deliveryPlan: {
                mode: "thread",
                postThreadText: true,
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
            });
          }

          const gatewaySnapshot = snapshotEnv([
            "AI_GATEWAY_API_KEY",
            "VERCEL_OIDC_TOKEN",
          ]);
          const baseToolOverrides: ToolHooks["toolOverrides"] = {
            ...(request.policy?.toolOverrides ?? {}),
          };
          const toolOverrides = {
            ...baseToolOverrides,
            webFetch: createReplayWebFetchDeps(baseToolOverrides),
            webSearch: createReplayWebSearchDeps(baseToolOverrides),
            ...(mockImageGeneration
              ? { imageGenerate: createMockImageGenerateDeps() }
              : {}),
          };
          if (scenario.overrides?.unset_gateway_api_key) {
            delete process.env.AI_GATEWAY_API_KEY;
            delete process.env.VERCEL_OIDC_TOKEN;
          }
          try {
            const outcome = await executeAgentRun({
              ...request,
              policy: {
                ...request.policy,
                turnDeadlineAtMs: Math.min(
                  request.policy?.turnDeadlineAtMs ?? Number.POSITIVE_INFINITY,
                  Date.now() + replyTimeoutMs,
                ),
                ...(env.configuredSkillDirs.length > 0
                  ? { skillDirs: env.configuredSkillDirs }
                  : {}),
                toolOverrides,
              },
              observers: {
                ...request.observers,
                onToolInvocation: (invocation) => {
                  observations.toolInvocations.push(
                    toEvalToolInvocation(invocation),
                  );
                },
              },
            });
            replyState.successfulCount += 1;
            return outcome;
          } finally {
            if (scenario.overrides?.unset_gateway_api_key) {
              gatewaySnapshot.restore();
            }
          }
        },
      },
      scheduleAgentContinue: async (request) => {
        await scheduleAgentContinue(request, {
          queue: conversationWorkQueue,
          state: env.stateAdapter,
        });
      },
      scheduleSessionCompletedPluginTasks: async (params) => {
        await scheduleSessionCompletedPluginTasks(params, {
          send: async (message) => {
            await processEvalPluginTask(message);
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
  getThreadRecord: (fixture: EvalEventThreadFixture) => EvalThreadRecord;
  findEvalThread: (threadId: string) => TestThread | undefined;
  observations: RuntimeObservations;
  readyQueueDeliveries: QueueDelivery[];
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
          run: createSlackConversationWorker({
            getSlackAdapter: () => getSlackAdapter() as unknown as SlackAdapter,
            resumeAwaitingContinuation: async (conversationId) =>
              await resumeAwaitingSlackContinuation(conversationId, {
                agentRunner,
                scheduleAgentContinue: async (request) => {
                  await scheduleAgentContinue(request, {
                    queue: conversationWorkQueue,
                    state: env.stateAdapter,
                  });
                },
                scheduleSessionCompletedPluginTasks: async (params) => {
                  await scheduleSessionCompletedPluginTasks(params, {
                    send: async (message) => {
                      await processEvalPluginTask(message);
                    },
                  });
                },
              }),
            runtime: workerRuntime,
            state: env.stateAdapter,
          }),
          state: env.stateAdapter,
        },
      );
      await maybeAutoCompleteAuth();
    }
  };

  // Persist batch members through real Slack ingress so the conversation
  // worker claims them as one mailbox batch (latest live, earlier queued).
  const appendMailboxBatch = async (
    batch: MessageBatchEvent,
  ): Promise<void> => {
    for (const [index, event] of batch.events.entries()) {
      const { thread, transcript } = getThreadRecord(event.thread);
      const route =
        (event.message.is_mention ?? event.type === "new_mention")
          ? ("mention" as const)
          : ("subscribed" as const);
      const message = ChatMessage.fromJSON(
        toSerializedSlackMessage(event, thread.id, Date.now() + index),
      );
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
    const { thread } = getThreadRecord(event.thread);
    const nowMs = event.now_ms ?? Date.parse("2026-05-26T12:00:00.000Z");
    const scheduleKind = event.schedule_kind ?? "one_off";
    const taskId = `eval_schedule_${thread.channelId}_${nowMs}`;
    const task: ScheduledTask = {
      id: taskId,
      createdAtMs: nowMs - 60_000,
      createdBy: { slackUserId: TEST_USER_ID, userName: "testuser" },
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
    const schedulerStore = createSchedulerSqlStore(
      getDb() as unknown as SchedulerDb,
    );
    await schedulerStore.saveTask(task);

    const callbacks: DispatchCallback[] = [];
    const expectedCallbackUrl = new URL(
      "/api/internal/agent-dispatch",
      process.env.JUNIOR_BASE_URL,
    ).href;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (new URL(url).href === expectedCallbackUrl) {
        const callback = await verifyDispatchCallbackRequest(
          new Request(input, init),
        );
        if (!callback) {
          return new Response("Unauthorized", { status: 401 });
        }
        callbacks.push(callback);
        return new Response("Accepted", { status: 202 });
      }
      return await originalFetch(input, init);
    }) as typeof fetch;
    try {
      await runPluginHeartbeats({ nowMs });
    } finally {
      globalThis.fetch = originalFetch;
    }
    if (callbacks.length === 0) {
      throw new Error(
        "Scheduled eval task did not enqueue a dispatch callback.",
      );
    }

    const dispatchedRuns = (await schedulerStore.listIncompleteRuns()).filter(
      (run) => run.taskId === taskId && run.dispatchId,
    );
    if (dispatchedRuns.length === 0) {
      const runs = (await schedulerStore.listIncompleteRuns()).filter(
        (run) => run.taskId === taskId,
      );
      const savedTask = await schedulerStore.getTask(taskId);
      throw new Error(
        `Scheduled eval task did not create a dispatch: ${JSON.stringify({ runs, savedTask })}`,
      );
    }
    for (const run of dispatchedRuns) {
      const dispatch = await getDispatchRecord(run.dispatchId!);
      if (!dispatch) {
        throw new Error("Scheduled eval dispatch record was not found.");
      }
      const callback = callbacks.find(
        (candidate) => candidate.id === dispatch.id,
      );
      if (!callback) {
        throw new Error("Scheduled eval dispatch callback was not captured.");
      }
      await runAgentDispatchSlice(callback, { agentRunner });
    }
  };

  for (const event of scenario.events) {
    if (event.type === "message_batch") {
      await appendMailboxBatch(event);
      await maybeAutoCompleteAuth();
      await drainQueuedConversationWork();
      continue;
    }
    if (event.type === "new_mention" || event.type === "subscribed_message") {
      enqueueEvent(event);
    } else if (event.type === "scheduled_task_due") {
      await runScheduledTaskDue(event);
    } else {
      await runLifecycleEvent(event);
    }
    await maybeAutoCompleteAuth();
    if (await processNextDelivery()) {
      await maybeAutoCompleteAuth();
      await drainQueuedConversationWork();
    }
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
): EvalResult {
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
    logRecords,
    authorizationCompletions: observations.authorizationCompletions,
    reactions,
    posts: [...threadPosts, ...callbackThreadPosts, ...filePosts],
    slackAdapter,
    toolInvocations: observations.toolInvocations,
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
  let previousPlugins: ReturnType<typeof setPlugins> | undefined;

  try {
    const usesMemoryPlugin = Boolean(
      scenario.overrides?.plugin_packages?.includes("@sentry/junior-memory"),
    );

    const currentPlugins = getPlugins();
    previousPlugins = setPlugins([
      schedulerPlugin(),
      ...(usesMemoryPlugin ? [createMemoryPlugin()] : []),
      ...currentPlugins.filter(
        (plugin) =>
          plugin.manifest.name !== "scheduler" &&
          (!usesMemoryPlugin || plugin.manifest.name !== "memory"),
      ),
    ]);
    const slackAdapter = new FakeSlackAdapter({ botUserId: TEST_BOT_USER_ID });
    const threadRecordsById = new Map<string, EvalThreadRecord>();
    const readyQueueDeliveries: QueueDelivery[] = [];
    const observations: RuntimeObservations = {
      authorizationCompletions: [],
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

    const conversationWorkQueue = createConversationWorkQueueTestAdapter();
    const services = buildRuntimeServices(
      scenario,
      env,
      threadRecordsById,
      observations,
      conversationWorkQueue,
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
// The toIncomingMessage function below still needs a local check since it maps from eval-specific fixtures.
type AssertAssignable<_TSub extends TSuper, TSuper> = true;
type _MessageCheck = AssertAssignable<
  ReturnType<typeof toIncomingMessage>,
  Pick<
    Message,
    "id" | "text" | "isMention" | "attachments" | "metadata" | "author"
  >
>;
