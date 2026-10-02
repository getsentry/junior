import {
  assistantMessages,
  createJudge,
  type DescribeEvalOptions,
  type JudgeContext,
} from "vitest-evals";
import {
  attachHarnessRunToError,
  serializeError,
  type Harness,
  type HarnessRun,
  type JsonValue,
  type NormalizedSession,
  type TranscriptEvent,
} from "vitest-evals/harness";
import { registerLogRecordSink, type EmittedLogRecord } from "@/chat/logging";
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
import { runEvalScenario } from "./behavior-harness";
import type {
  EvalEvent,
  EvalOverrides,
  EvalResult,
  HistoryEvent,
  InitialEvents,
  SteerEvent,
} from "./harness/types";
import { runEvalWork } from "./eval-work";
import { toEvalHarnessRun } from "./eval-result";
import {
  formatJudgePrompt,
  formatRubric,
  JUDGE_SCORES,
  JUDGE_SYSTEM,
  JUDGE_THRESHOLD,
  judgeHarness,
  parseJudgeResult,
  type Rubric,
} from "./fixture/judge";

export { rubric } from "./fixture/judge";

type NormalizedMessage = EvalResult["sessionMessages"][number];

type ReactionAddedMessage = NormalizedMessage & {
  role: "assistant";
  content: {
    type: "reaction_added";
    emoji: string;
  };
};

function isReactionAddedMessage(
  message: NormalizedMessage,
): message is ReactionAddedMessage {
  const content = message.content;
  return (
    message.role === "assistant" &&
    message.metadata?.event_type === "reaction_added" &&
    content !== null &&
    typeof content === "object" &&
    !Array.isArray(content) &&
    content.type === "reaction_added" &&
    typeof content.emoji === "string"
  );
}

/** Returns typed reaction emoji side effects recorded in an eval session. */
export function reactionEmojis(session: NormalizedSession): string[] {
  return session.events
    .filter(
      (event): event is TranscriptEvent & ReactionAddedMessage =>
        event.type === "message" && isReactionAddedMessage(event),
    )
    .map((message) => message.content.emoji);
}

const CONVERSATION_IDS_METADATA_KEY = "conversation_ids";

/** Return string content from a normalized assistant message value. */
export function assistantTextContent(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Return visible text or file replies posted in the active thread. */
export function visibleThreadReplies(session: NormalizedSession) {
  return assistantMessages(session).filter(
    (message) =>
      message.metadata?.event_type === "thread_post" &&
      (assistantTextContent(message.content).trim().length > 0 ||
        (Array.isArray(message.metadata.files) &&
          message.metadata.files.length > 0)),
  );
}

/** Return visible replies from the last user turn. */
export function lastTurnReplies(session: NormalizedSession) {
  let start = session.events.length;
  while (start > 0) {
    const event = session.events[start - 1];
    if (event?.type === "message" && event.role === "user") break;
    start -= 1;
  }
  return visibleThreadReplies({
    ...session,
    events: session.events.slice(start),
  });
}

/** Join user-visible assistant text recorded in an eval session. */
export function visibleAssistantText(session: NormalizedSession): string {
  return assistantMessages(session)
    .map((message) => assistantTextContent(message.content))
    .join("\n");
}

/** Serialize user-visible conversation text and Slack author attribution. */
export function serializeVisibleTranscript(session: NormalizedSession): string {
  return JSON.stringify(
    session.events.flatMap((event) => {
      if (
        event.type !== "message" ||
        (event.role !== "user" && event.role !== "assistant") ||
        typeof event.content !== "string" ||
        event.metadata?.rubric_visible === false
      ) {
        return [];
      }
      const files = event.metadata?.files;
      const attachments = Array.isArray(files)
        ? files.flatMap((file) =>
            file &&
            typeof file === "object" &&
            !Array.isArray(file) &&
            typeof file.filename === "string"
              ? [
                  `[attached ${file.isImage ? "image" : "file"}: ${file.filename}]`,
                ]
              : [],
          )
        : [];
      const content = [event.content, ...attachments]
        .filter(Boolean)
        .join("\n");
      if (!content.trim()) return [];
      return [
        {
          role: event.role,
          ...(event.role === "user" && event.metadata?.author_name
            ? { author: event.metadata.author_name }
            : {}),
          content,
        },
      ];
    }),
    null,
    2,
  );
}

// ── Core eval wrapper ──────────────────────────────────────

export interface SlackEvalInput {
  /** Prior turns preloaded through the runtime's stores before the scenario starts. */
  history?: HistoryEvent[];
  initialEvents: InitialEvents;
  events?: Array<EvalEvent | SteerEvent>;
  overrides?: EvalOverrides;
  criteria?: Rubric;
  requireGatewayReady?: boolean;
  requireSandboxReady?: boolean;
}

const SANDBOX_SETUP_FAILED_TEXT = "Error: sandbox setup failed";
const MAX_EVAL_TIMEOUT_MS = 60_000;
const GATEWAY_AUTH_FAILURE_PATTERNS = [
  "OIDC token has expired",
  "Missing AI gateway credentials",
  '"type":"authentication_error"',
];
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
}

/** Replays Slack events through the real runtime and returns normalized artifacts. */
export const slackHarness: Harness<SlackEvalInput> = {
  name: "slack",
  run: (input, { signal }) =>
    runEvalWork(async () => {
      const startedAt = Date.now();
      const logRecords: EmittedLogRecord[] = [];
      const unregisterLogSink = registerLogRecordSink((record) => {
        logRecords.push(record);
      });
      try {
        assertTimeoutBudget(input);
        const result = await runEvalScenario(
          {
            history: input.history,
            initialEvents: input.initialEvents,
            events: input.events,
            overrides: input.overrides,
          },
          { logRecords, signal },
        );
        const run = toEvalHarnessRun(result, Date.now() - startedAt);
        try {
          if (input.requireGatewayReady ?? true) assertGatewayReady(result);
          if (input.requireSandboxReady ?? true) assertSandboxReady(result);
          assertStatusCleared(result);
        } catch (error) {
          run.errors = [serializeError(error)];
          throw attachHarnessRunToError(error, run);
        }
        return run;
      } finally {
        unregisterLogSink();
      }
    }),
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
    if (!input.criteria) {
      return {
        score: 1,
        metadata: { skipped: "deterministic-only" },
      };
    }
    if (!runJudge) {
      throw new Error("RubricJudge requires a configured judgeHarness.");
    }
    const object = parseJudgeResult(
      String(
        await runJudge({
          prompt: formatJudgePrompt(
            serializeVisibleTranscript(session),
            formatRubric(input.criteria),
          ),
          system: JUDGE_SYSTEM,
        }),
      ),
    );
    const answer = object.answer;

    return {
      score: JUDGE_SCORES[answer],
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
  judgeThreshold: JUDGE_THRESHOLD,
} satisfies DescribeEvalOptions<SlackEvalInput>;

/** Return runtime conversation ids recorded for this harness run. */
export function conversationIds(result: Pick<HarnessRun, "session">): string[] {
  const value = result.session.metadata?.[CONVERSATION_IDS_METADATA_KEY];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

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

/** Builds a subscribed-thread message for a harnessed Slack eval. */
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

/** Builds a prior Junior reply to preload before the scenario starts. */
export function reply(text: string, opts?: { thread?: ThreadOverrides }) {
  const seq = nextId();
  const thread = evalThread(seq, opts?.thread);
  return {
    type: "assistant_reply" as const,
    thread,
    message: { id: messageTs(seq), text },
  };
}

/** Models Slack messages that arrive while the preceding agent run is active. */
export function steer(
  ...events: Array<
    ReturnType<typeof mention> | ReturnType<typeof threadMessage>
  >
) {
  if (events.length === 0) {
    throw new Error("steer() requires at least one message event");
  }
  return {
    type: "steer" as const,
    events,
  };
}

interface EventOptions {
  eventKey?: string;
  eventType: string;
  intent: string;
  label: string;
  namespace?: string;
  identifier: string;
  resourceType: string;
  thread?: ThreadOverrides;
  trustedSummary: string;
  data?: Record<string, unknown>;
  untrustedText?: string;
}

interface GitHubWebhookOptions {
  body: unknown;
  deliveryId?: string;
  eventName: string;
  subscription: {
    events: string[];
    intent: string;
    label: string;
    identifier: string;
    resourceType: string;
  };
  thread?: ThreadOverrides;
}

/** Builds a GitHub webhook delivery backed by a real watch. */
export function githubWebhook(opts: GitHubWebhookOptions) {
  const seq = nextId();
  return {
    type: "github_webhook" as const,
    thread: {
      id: `thread-${seq}`,
      channel_id: `C${seq}`,
      thread_ts: `17000000.${seq}`,
      ...opts.thread,
    },
    body: opts.body,
    delivery_id: opts.deliveryId ?? `eval-github-delivery-${seq}`,
    event_name: opts.eventName,
    subscription: {
      events: opts.subscription.events,
      intent: opts.subscription.intent,
      label: opts.subscription.label,
      identifier: opts.subscription.identifier,
      resource_type: opts.subscription.resourceType,
    },
  };
}

/** Builds an Event for the production mailbox path. */
export function event(opts: EventOptions) {
  const seq = nextId();
  const eventKey = opts.eventKey ?? `eval-event-${seq}`;
  return {
    type: "event" as const,
    thread: {
      id: `thread-${seq}`,
      channel_id: `C${seq}`,
      thread_ts: `17000000.${seq}`,
      ...opts.thread,
    },
    event_key: eventKey,
    event_type: opts.eventType,
    intent: opts.intent,
    label: opts.label,
    namespace: opts.namespace ?? "github",
    identifier: opts.identifier,
    resource_type: opts.resourceType,
    trusted_summary: opts.trustedSummary,
    ...(opts.data ? { data: opts.data } : {}),
    ...(opts.untrustedText ? { untrusted_text: opts.untrustedText } : {}),
  };
}

/** Builds an event for a scheduled automation becoming due and dispatching output. */
export function scheduledAutomationDue(
  taskText: string,
  opts?: {
    credential_mode?: "creator" | "system";
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
    type: "scheduled_automation_due" as const,
    thread: {
      id: `thread-${seq}`,
      channel_id: `C${seq}`,
      thread_ts: `17000000.${seq}`,
      ...opts?.thread,
    },
    task_text: taskText,
    ...(opts?.credential_mode ? { credential_mode: opts.credential_mode } : {}),
    ...(opts?.now_ms ? { now_ms: opts.now_ms } : {}),
    ...(opts?.recurrence ? { recurrence: opts.recurrence } : {}),
    ...(opts?.schedule ? { schedule: opts.schedule } : {}),
    ...(opts?.schedule_kind ? { schedule_kind: opts.schedule_kind } : {}),
    ...(opts?.timezone ? { timezone: opts.timezone } : {}),
  };
}
