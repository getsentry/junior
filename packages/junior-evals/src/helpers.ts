import {
  createJudge,
  createJudgeHarness,
  type DescribeEvalOptions,
  type JudgeContext,
} from "vitest-evals";
import { completeText, resolveGatewayModel } from "@/chat/pi/client";
import {
  toJsonValue,
  type Harness,
  type HarnessRun,
  type JsonValue,
  type NormalizedMessage,
  type NormalizedSession,
  type ToolCallRecord,
} from "vitest-evals/harness";
import { registerLogRecordSink, type EmittedLogRecord } from "@/chat/logging";
import { getAgentStepStore, getConversationMessageStore } from "@/chat/db";
import type { AgentStepEntry } from "@/chat/conversations/history";
import type { ConversationMessage } from "@/chat/conversations/messages";
import { advisorChildConversationId } from "@/chat/tools/advisor/tool";
import {
  slackEventThread,
  slackMentionEvent,
  slackSubscribedMessageEvent,
  type SlackEventThreadFixture,
  type SlackEventUser,
} from "@junior-tests/fixtures/slack/factories/events";
import { TEST_USER_ID } from "@junior-tests/fixtures/slack/factories/ids";
import { parseSlackChannelId, parseSlackUserId } from "@/chat/slack/ids";
import { parseSlackMessageTs } from "@/chat/slack/timestamp";
import {
  type EvalEvent,
  type EvalOverrides,
  type EvalResult,
  runEvalScenario,
} from "./behavior-harness";

function hasAssistantStatusPending(result: EvalResult): boolean {
  const lastByThread = new Map<string, string>();
  for (const call of result.slackAdapter.statusCalls) {
    lastByThread.set(`${call.channelId}:${call.threadTs}`, call.text);
  }
  for (const text of lastByThread.values()) {
    if (text !== "") return true;
  }
  return false;
}

function toJson(value: unknown): JsonValue {
  return toJsonValue(value) ?? null;
}

function toJsonRecord(
  value: Record<string, unknown>,
): Record<string, JsonValue> {
  const record: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    record[key] = toJson(entry);
  }
  return record;
}

function slackMetadata(result: EvalResult): Record<string, JsonValue> {
  return {
    thread_title_set: result.slackAdapter.titleCalls.length > 0,
    suggested_prompts_set: result.slackAdapter.promptCalls.length > 0,
    assistant_status_pending: hasAssistantStatusPending(result),
  };
}

function authorizationArtifacts(result: EvalResult): JsonValue {
  return result.authorizationCompletions.map((completion) => ({
    credential_stored: completion.credentialStored,
    delivery: completion.delivery,
    kind: completion.kind,
    provider: completion.provider,
    user_id: completion.userId,
  }));
}

function toToolCallRecord(
  invocation: EvalResult["toolInvocations"][number],
): ToolCallRecord {
  const args: Record<string, JsonValue> = {};
  if (invocation.arguments) {
    const genericArgs = toJson(invocation.arguments);
    if (
      genericArgs &&
      typeof genericArgs === "object" &&
      !Array.isArray(genericArgs)
    ) {
      Object.assign(args, genericArgs);
    } else {
      args.value = genericArgs;
    }
  }
  if (invocation.bash_command) {
    args.command = invocation.bash_command;
  }
  if (invocation.skill_name) {
    args.skill_name = invocation.skill_name;
  }
  if (invocation.mcp_tool_name) {
    args.tool_name = invocation.mcp_tool_name;
  }
  if (invocation.mcp_arguments) {
    args.arguments = toJson(invocation.mcp_arguments);
  }

  return {
    name: invocation.tool,
    ...(Object.keys(args).length > 0 ? { arguments: args } : {}),
    ...(invocation.completed
      ? {
          result: toJson(
            invocation.result ?? {
              ok: invocation.ok ?? invocation.error === undefined,
            },
          ),
        }
      : {}),
    ...(invocation.error ? { error: { message: invocation.error } } : {}),
  };
}

function toLogMetadata(record: EmittedLogRecord): Record<string, JsonValue> {
  return toJsonRecord({
    eventName: record.eventName,
    body: record.body,
    level: record.level,
    attributes: record.attributes,
  });
}

function serializeSession(session: NormalizedSession): string {
  const metadata = { ...(session.metadata ?? {}) };
  delete metadata.log_records;
  return JSON.stringify(
    {
      messages: session.messages,
      metadata,
    },
    null,
    2,
  );
}

function toAssistantPostMessage(
  post: EvalResult["posts"][number],
): NormalizedMessage {
  return {
    role: "assistant",
    content: post.text,
    metadata: toJsonRecord({
      event_type: post.eventType ?? "thread_post",
      ...(post.channel ? { channel: post.channel } : {}),
      ...(post.thread_ts ? { thread_ts: post.thread_ts } : {}),
      files: post.files,
    }),
  };
}

function buildPostKey(post: {
  channel?: string;
  text: string;
  thread_ts?: string;
}): string {
  return `${post.channel ?? ""}\u0000${post.thread_ts ?? ""}\u0000${post.text}`;
}

function toSessionMessages(
  result: EvalResult,
  toolCalls: ToolCallRecord[],
): NormalizedMessage[] {
  const threadPostKeys = new Set(result.posts.map(buildPostKey));
  return [
    ...result.posts.map(toAssistantPostMessage),
    ...result.channelPosts
      .filter((post) => !threadPostKeys.has(buildPostKey(post)))
      .map(
        (post): NormalizedMessage => ({
          role: "assistant",
          content: post.text,
          metadata: toJsonRecord({
            event_type: post.thread_ts ? "thread_post" : "channel_post",
            channel: post.channel,
            ...(post.thread_ts ? { thread_ts: post.thread_ts } : {}),
          }),
        }),
      ),
    ...result.reactions.map(
      (reaction): NormalizedMessage => ({
        role: "assistant",
        content: {
          type: "reaction_added",
          emoji: reaction.emoji,
        },
        metadata: toJsonRecord({
          event_type: "reaction_added",
          channel: reaction.channel,
          timestamp: reaction.timestamp,
        }),
      }),
    ),
    ...result.canvases.map(
      (canvas): NormalizedMessage => ({
        role: "assistant",
        content: {
          type: "canvas_created",
          title: canvas.title,
          markdown: canvas.markdown,
        },
        metadata: {
          event_type: "canvas_created",
        },
      }),
    ),
    ...(toolCalls.length > 0
      ? [
          {
            role: "assistant" as const,
            toolCalls,
          },
        ]
      : []),
  ];
}

function toHarnessRun(result: EvalResult): HarnessRun {
  const toolCalls = result.toolInvocations.map(toToolCallRecord);
  const messages = toSessionMessages(result, toolCalls);

  return {
    artifacts: {
      authorization_completions: authorizationArtifacts(result),
    },
    session: {
      messages,
      metadata: toJsonRecord({
        slack_metadata: slackMetadata(result),
        log_records: result.logRecords.map(toLogMetadata),
        [CONVERSATION_IDS_METADATA_KEY]: result.conversationIds,
      }),
    },
    usage: {
      toolCalls: toolCalls.length,
    },
    errors: [],
  };
}

// ── Core eval wrapper ──────────────────────────────────────

interface EvalRubric {
  pass: readonly string[];
  fail?: readonly string[];
}

export interface SlackEvalInput {
  events: EvalEvent[];
  overrides?: EvalOverrides;
  criteria: EvalRubric;
  requireGatewayReady?: boolean;
  taskTimeout?: number;
  requireSandboxReady?: boolean;
}

const SANDBOX_SETUP_FAILED_TEXT = "Error: sandbox setup failed";
const MAX_EVAL_TIMEOUT_MS = 30_000;
const GATEWAY_AUTH_FAILURE_PATTERNS = [
  "OIDC token has expired",
  "Missing AI gateway credentials",
  '"type":"authentication_error"',
];

function formatBulletSection(
  title: string,
  items: readonly string[] | undefined,
): string | null {
  if (!items || items.length === 0) {
    return null;
  }

  return `${title}:\n${items.map((item) => `- ${item}`).join("\n")}`;
}

function formatRubric(criteria: EvalRubric): string {
  return [
    formatBulletSection("Pass", criteria.pass),
    formatBulletSection("Fail", criteria.fail),
  ]
    .filter((section): section is string => section !== null)
    .join("\n\n");
}

function assertGatewayReady(result: EvalResult): void {
  const failure = result.logRecords.find((record) => {
    if (record.eventName !== "ai_completion_failed") {
      return false;
    }
    const errorMessage = String(record.attributes["exception.message"] ?? "");
    return GATEWAY_AUTH_FAILURE_PATTERNS.some((pattern) =>
      errorMessage.includes(pattern),
    );
  });
  if (!failure) {
    return;
  }

  const message =
    String(failure.attributes["exception.message"] ?? "").trim() ||
    failure.body ||
    "AI Gateway authentication failed";
  throw new Error(
    `Eval gateway bootstrap failed. Received "${message}". ` +
      "Refresh AI Gateway auth first (for example via `vercel env pull`) and retry.",
  );
}

function assertSandboxReady(result: EvalResult): void {
  const failingPosts = result.posts.filter((post) =>
    post.text.includes(SANDBOX_SETUP_FAILED_TEXT),
  );
  if (failingPosts.length === 0) {
    return;
  }

  const sample = failingPosts[0]?.text ?? SANDBOX_SETUP_FAILED_TEXT;
  throw new Error(
    `Eval sandbox bootstrap failed. Received "${sample}". ` +
      "Evals require a working Vercel Sandbox and do not permit local fallback.",
  );
}

function assertStatusCleared(result: EvalResult): void {
  const lastByThread = new Map<string, string>();
  for (const call of result.slackAdapter.statusCalls) {
    const key = `${call.channelId}:${call.threadTs}`;
    lastByThread.set(key, call.text);
  }
  for (const [thread, text] of lastByThread) {
    if (text !== "") {
      throw new Error(
        `Eval left assistant status pending on thread ${thread}: "${text}". ` +
          "Every turn must clear the assistant status indicator before completing.",
      );
    }
  }
}

function assertTimeoutBudget(input: SlackEvalInput): void {
  const replyTimeout = input.overrides?.reply_timeout_ms;
  if (replyTimeout !== undefined && replyTimeout > MAX_EVAL_TIMEOUT_MS) {
    throw new Error(
      `Eval reply_timeout_ms ${replyTimeout} exceeds the ${MAX_EVAL_TIMEOUT_MS}ms budget. Use fixtures, mocks, or tool replay instead of raising timeouts.`,
    );
  }
  if (
    input.taskTimeout !== undefined &&
    input.taskTimeout > MAX_EVAL_TIMEOUT_MS
  ) {
    throw new Error(
      `Eval taskTimeout ${input.taskTimeout} exceeds the ${MAX_EVAL_TIMEOUT_MS}ms budget. Use fixtures, mocks, or tool replay instead of raising timeouts.`,
    );
  }
}

/** Builds a structured, maintainer-readable judge rubric for an eval case. */
export function rubric(criteria: EvalRubric): EvalRubric {
  if (criteria.pass.length === 0) {
    throw new Error("Eval rubric must include at least one pass condition.");
  }
  return criteria;
}

type JudgeAnswer = "A" | "B" | "C" | "D" | "E";

interface JudgeResultPayload {
  answer: JudgeAnswer;
  rationale: string;
}

const CHOICE_SCORES: Record<JudgeAnswer, number> = {
  A: 1,
  B: 0.75,
  C: 0.5,
  D: 0.25,
  E: 0,
};

const EVAL_SYSTEM =
  'You are assessing a submitted output based on a given criterion. Ignore differences in style, grammar, punctuation, or length. Focus only on whether the criterion is met. Return only raw JSON matching {"answer":"A","rationale":"..."}.';
const EVAL_JUDGE_MODEL_ID = resolveGatewayModel("openai/gpt-5.4").id;

const judgeHarness = createJudgeHarness({
  name: "slack-rubric-judge-model",
  run: async ({ prompt, system }) => {
    const { text } = await completeText({
      modelId: EVAL_JUDGE_MODEL_ID,
      system,
      messages: [
        {
          role: "user",
          content: prompt,
          timestamp: Date.now(),
        },
      ],
      temperature: 0,
    });
    return text;
  },
});

function formatJudgePrompt(output: string, criteria: string): string {
  return `<submission>
${output}
</submission>

<criteria>
${criteria}
</criteria>

Does the submission meet the criteria? Select one option:
(A) The criteria is fully met with no issues
(B) The criteria is mostly met with minor gaps
(C) The criteria is partially met with notable gaps
(D) The criteria is barely met or only tangentially addressed
(E) The criteria is not met at all

Return only a JSON object with:
- answer: one of "A", "B", "C", "D", "E"
- rationale: a concise explanation`;
}

function isJudgeAnswer(value: unknown): value is JudgeAnswer {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(CHOICE_SCORES, value)
  );
}

function parseJudgeResult(text: string): JudgeResultPayload {
  const parsed = JSON.parse(text) as unknown;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !isJudgeAnswer((parsed as Record<string, unknown>).answer) ||
    typeof (parsed as Record<string, unknown>).rationale !== "string"
  ) {
    throw new Error(`Rubric judge returned invalid JSON: ${text}`);
  }
  return parsed as JudgeResultPayload;
}

/** Replays Slack events through the real runtime and returns normalized artifacts. */
export const slackHarness: Harness<SlackEvalInput> = {
  name: "slack",
  run: async (input) => {
    const logRecords: EmittedLogRecord[] = [];
    const unregisterLogSink = registerLogRecordSink((record) => {
      logRecords.push(record);
    });
    try {
      assertTimeoutBudget(input);
      const taskPromise = runEvalScenario(
        {
          events: input.events,
          overrides: input.overrides,
        },
        { logRecords },
      );
      const result =
        typeof input.taskTimeout === "number" && input.taskTimeout > 0
          ? await Promise.race([
              taskPromise,
              new Promise<never>((_, reject) =>
                setTimeout(
                  () =>
                    reject(
                      new Error(
                        `Eval harness timed out after ${input.taskTimeout}ms before judge evaluation`,
                      ),
                    ),
                  input.taskTimeout,
                ),
              ),
            ])
          : await taskPromise;
      if (input.requireGatewayReady ?? true) {
        assertGatewayReady(result);
      }
      if (input.requireSandboxReady ?? true) {
        assertSandboxReady(result);
      }
      assertStatusCleared(result);
      return toHarnessRun(result);
    } finally {
      unregisterLogSink();
    }
  },
};

/** Scores Slack eval output against the case rubric. */
export const RubricJudge = createJudge(
  "RubricJudge",
  async ({
    input,
    session,
    runJudge,
  }: JudgeContext<
    SlackEvalInput,
    JsonValue | undefined,
    typeof slackHarness
  >) => {
    if (!runJudge) {
      throw new Error("RubricJudge requires a configured judgeHarness.");
    }
    const object = parseJudgeResult(
      String(
        await runJudge({
          prompt: formatJudgePrompt(
            serializeSession(session),
            formatRubric(input.criteria),
          ),
          system: EVAL_SYSTEM,
        }),
      ),
    );
    const answer = object.answer as keyof typeof CHOICE_SCORES;

    return {
      score: CHOICE_SCORES[answer],
      metadata: {
        answer,
        rationale: object.rationale,
      },
    };
  },
);

/** Shared vitest-evals suite options for Slack conversation evals. */
export const slackEvals = {
  harness: slackHarness,
  judgeHarness,
  judges: [RubricJudge],
  judgeThreshold: 0.75,
} satisfies DescribeEvalOptions<SlackEvalInput>;

export interface AuthorizationCompletionView {
  credentialStored: boolean;
  delivery: "direct_message" | "ephemeral";
  kind: "mcp" | "plugin";
  provider: string;
  userId: string;
}

/** Return completed provider authorizations verified through the credential store. */
export function authorizationCompletions(
  result: HarnessRun,
): AuthorizationCompletionView[] {
  const completions = result.artifacts?.authorization_completions;
  if (!Array.isArray(completions)) {
    return [];
  }
  return completions.flatMap((completion) => {
    if (
      !completion ||
      typeof completion !== "object" ||
      Array.isArray(completion)
    ) {
      return [];
    }
    const provider = completion.provider;
    const userId = completion.user_id;
    const delivery = completion.delivery;
    const kind = completion.kind;
    const credentialStored = completion.credential_stored;
    if (
      typeof provider !== "string" ||
      typeof userId !== "string" ||
      (delivery !== "ephemeral" && delivery !== "direct_message") ||
      (kind !== "mcp" && kind !== "plugin") ||
      typeof credentialStored !== "boolean"
    ) {
      return [];
    }
    return [{ credentialStored, delivery, kind, provider, userId }];
  });
}

// ── Event builders ─────────────────────────────────────────

let _seq = 0;
function nextId() {
  return String(++_seq);
}

function messageTs(seq: string) {
  return `17000001.${seq}`;
}

const DEFAULT_AUTHOR: SlackEventUser = {
  user_id: TEST_USER_ID,
  user_name: "testuser",
  full_name: "Test User",
  is_me: false,
  is_bot: false,
};

type AuthorOverrides = Partial<SlackEventUser>;

interface ThreadOverrides extends Partial<SlackEventThreadFixture> {
  channel_type?: "channel" | "group" | "im" | "mpim";
}

function evalAuthor(overrides?: AuthorOverrides): SlackEventUser {
  const author = { ...DEFAULT_AUTHOR, ...overrides };
  if (!parseSlackUserId(author.user_id)) {
    throw new Error(`Invalid eval Slack user id: ${author.user_id}`);
  }
  return author;
}

function evalThread(
  seq: string,
  overrides?: ThreadOverrides,
): SlackEventThreadFixture & Pick<ThreadOverrides, "channel_type"> {
  const thread = slackEventThread({
    id: `thread-${seq}`,
    channel_id: `C${seq}`,
    thread_ts: `17000000.${seq}`,
    ...overrides,
  });
  if (!parseSlackChannelId(thread.channel_id)) {
    throw new Error(`Invalid eval Slack channel id: ${thread.channel_id}`);
  }
  if (!parseSlackMessageTs(thread.thread_ts)) {
    throw new Error(`Invalid eval Slack thread timestamp: ${thread.thread_ts}`);
  }
  return {
    ...thread,
    ...(overrides?.channel_type
      ? { channel_type: overrides.channel_type }
      : {}),
  };
}

/** Builds a first-turn mention event for a harnessed Slack eval. */
export function mention(
  text: string,
  opts?: { author?: AuthorOverrides; thread?: ThreadOverrides },
) {
  const seq = nextId();
  const thread = evalThread(seq, opts?.thread);
  const event = slackMentionEvent({
    thread,
    message: {
      id: messageTs(seq),
      text,
      author: evalAuthor(opts?.author),
    },
  });
  return {
    ...event,
    thread: {
      ...event.thread,
      ...(thread.channel_type ? { channel_type: thread.channel_type } : {}),
    },
  };
}

/** Builds a follow-up subscribed-thread message for a harnessed Slack eval. */
export function threadMessage(
  text: string,
  opts?: {
    author?: AuthorOverrides;
    thread?: ThreadOverrides;
    is_mention?: boolean;
  },
) {
  const seq = nextId();
  const thread = evalThread(seq, opts?.thread);
  const event = slackSubscribedMessageEvent({
    thread,
    message: {
      id: messageTs(seq),
      text,
      is_mention: opts?.is_mention ?? false,
      author: evalAuthor(opts?.author),
    },
  });
  return {
    ...event,
    thread: {
      ...event.thread,
      ...(thread.channel_type ? { channel_type: thread.channel_type } : {}),
    },
  };
}

/**
 * Groups messages that are pending together in the conversation mailbox so
 * the worker handles them as one turn: the last message becomes the live
 * turn and earlier ones arrive as queued context, matching production
 * mailbox batching when messages land faster than turns complete.
 */
export function batch(
  ...events: Array<
    ReturnType<typeof mention> | ReturnType<typeof threadMessage>
  >
) {
  return {
    type: "message_batch" as const,
    events,
  };
}

interface ResourceEventNotificationOptions {
  eventKey?: string;
  eventType: string;
  intent: string;
  label: string;
  provider?: string;
  resourceRef: string;
  subscriptionId?: string;
  thread?: ThreadOverrides;
  trustedSummary: string;
  untrustedText?: string;
}

function resourceEventNotificationText(
  opts: ResourceEventNotificationOptions,
): string {
  const lines = [
    "[event notification]",
    "",
    "A subscribed resource changed.",
    "",
    "Subscription:",
    `- resource: ${opts.label}`,
    `- event: ${opts.eventType}`,
    `- intent: ${opts.intent}`,
    "",
    "Trusted event summary:",
    opts.trustedSummary,
  ];
  if (opts.untrustedText?.trim()) {
    lines.push("", "Untrusted provider content:", opts.untrustedText.trim());
  }
  return lines.join("\n");
}

/** Builds a runtime-owned subscribed resource-event notification for Slack evals. */
export function resourceEventNotification(
  opts: ResourceEventNotificationOptions,
) {
  const seq = nextId();
  const eventKey = opts.eventKey ?? `eval-resource-event-${seq}`;
  const subscriptionId = opts.subscriptionId ?? `eval-subscription-${seq}`;
  return {
    type: "subscribed_message" as const,
    thread: {
      id: `thread-${seq}`,
      channel_id: `C${seq}`,
      thread_ts: `17000000.${seq}`,
      ...opts.thread,
    },
    message: {
      id: `resource-event-${subscriptionId}-${eventKey}`,
      text: resourceEventNotificationText(opts),
      is_mention: false,
      author: {
        user_id: "UJRNEVENT",
        user_name: "junior-event",
        full_name: "Junior event",
        is_me: false,
        is_bot: true,
      },
      raw: {
        event_type: "resource_event",
        provider: opts.provider ?? "github",
        resource_ref: opts.resourceRef,
        subscription_id: subscriptionId,
        type: "message",
        user: "UJRNEVENT",
      },
    },
  };
}

/** Builds an event for a scheduled task becoming due and dispatching output. */
export function scheduledTaskDue(
  taskText: string,
  opts?: {
    now_ms?: number;
    recurrence?: "daily" | "weekly" | "monthly" | "yearly";
    schedule?: string;
    schedule_kind?: "one_off" | "recurring";
    thread?: ThreadOverrides;
    timezone?: string;
  },
) {
  const seq = nextId();
  return {
    type: "scheduled_task_due" as const,
    thread: {
      id: `thread-${seq}`,
      channel_id: `C${seq}`,
      thread_ts: `17000000.${seq}`,
      ...opts?.thread,
    },
    task_text: taskText,
    ...(opts?.now_ms ? { now_ms: opts.now_ms } : {}),
    ...(opts?.recurrence ? { recurrence: opts.recurrence } : {}),
    ...(opts?.schedule ? { schedule: opts.schedule } : {}),
    ...(opts?.schedule_kind ? { schedule_kind: opts.schedule_kind } : {}),
    ...(opts?.timezone ? { timezone: opts.timezone } : {}),
  };
}

/** Builds an assistant thread lifecycle start event for a harnessed Slack eval. */
export function threadStart(opts?: {
  thread?: ThreadOverrides;
  user_id?: string;
}) {
  const seq = nextId();
  return {
    type: "assistant_thread_started" as const,
    thread: {
      id: `thread-${seq}`,
      channel_id: `C${seq}`,
      thread_ts: `17000000.${seq}`,
      ...opts?.thread,
    },
    user_id: opts?.user_id ?? `U-${seq}`,
  };
}

// ── Durable-storage assertion helpers ──────────────────────
//
// These read back through the same SQL store ports the runtime writes to, using
// the database the eval harness booted. They let a case prove conversation
// content durably landed in the right store without inventing a parallel schema
// or reaching for raw SQL/Drizzle in eval code.

const CONVERSATION_IDS_METADATA_KEY = "conversation_ids";

/** One durable execution step, flattened for ordering/presence assertions. */
export interface AgentStepView {
  seq: number;
  contextEpoch: number;
  type: AgentStepEntry["type"];
  /** Message role for `pi_message` steps; absent for host-only step types. */
  role?: string;
  /** The strictly validated step payload, for deeper assertions when needed. */
  entry: AgentStepEntry;
}

function conversationIdsFromSession(session: NormalizedSession): string[] {
  const raw = session.metadata?.[CONVERSATION_IDS_METADATA_KEY];
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string")) {
    throw new Error(
      "Session metadata is missing conversation_ids; run through slackEvals so the harness records the run's conversation ids.",
    );
  }
  return raw as string[];
}

/**
 * The single conversation id for the run. Throws when a scenario produced zero
 * or multiple conversations so the author passes an explicit id to the readers.
 */
export function conversationId(session: NormalizedSession): string {
  const ids = conversationIdsFromSession(session);
  if (ids.length !== 1) {
    throw new Error(
      `Expected exactly one conversation for this run but found ${ids.length} (${ids.join(", ")}). Pass an explicit conversationId to agentSteps/conversationMessages.`,
    );
  }
  return ids[0]!;
}

function toStepRole(entry: AgentStepEntry): string | undefined {
  if (entry.type === "pi_message") {
    const role = (entry.message as { role?: unknown }).role;
    return typeof role === "string" ? role : undefined;
  }
  return undefined;
}

/**
 * The run's durable execution step rows, in `seq` order across every epoch,
 * read via `AgentStepStore.loadHistory`. Defaults to the run's sole
 * conversation; pass a conversation id to inspect a child (e.g. an advisor
 * child conversation).
 */
export async function agentSteps(
  session: NormalizedSession,
  conversationIdOverride?: string,
): Promise<AgentStepView[]> {
  const id = conversationIdOverride ?? conversationId(session);
  const steps = await getAgentStepStore().loadHistory(id);
  return steps.map((step) => ({
    seq: step.seq,
    contextEpoch: step.contextEpoch,
    type: step.entry.type,
    ...(toStepRole(step.entry) !== undefined
      ? { role: toStepRole(step.entry) }
      : {}),
    entry: step.entry,
  }));
}

/**
 * The run's visible conversation message rows in `created_at` order, read via
 * `ConversationMessageStore.list`. Defaults to the run's sole conversation.
 */
export async function conversationMessages(
  session: NormalizedSession,
  conversationIdOverride?: string,
): Promise<ConversationMessage[]> {
  const id = conversationIdOverride ?? conversationId(session);
  return await getConversationMessageStore().list(id);
}

/** Deterministic advisor child conversation id derived from a parent id. */
export { advisorChildConversationId };
