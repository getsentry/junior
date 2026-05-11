import {
  namedJudge,
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
  type ToolCallRecord,
} from "vitest-evals/harness";
import { registerLogRecordSink, type EmittedLogRecord } from "@/chat/logging";
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

function buildEvalOutput(result: EvalResult): Record<string, JsonValue> {
  return {
    assistant_posts: toJson(result.posts),
    observed_tool_invocations: toJson(result.toolInvocations),
    canvases: toJson(result.canvases),
    channel_posts: toJson(result.channelPosts),
    reactions: toJson(result.reactions),
    slack_metadata: {
      thread_title_set: result.slackAdapter.titleCalls.length > 0,
      suggested_prompts_set: result.slackAdapter.promptCalls.length > 0,
      assistant_status_pending: hasAssistantStatusPending(result),
    },
  };
}

function serializeEvalOutput(output: Record<string, JsonValue>): string {
  return JSON.stringify(output, null, 2);
}

function toToolCallRecord(
  invocation: EvalResult["toolInvocations"][number],
): ToolCallRecord {
  const args: Record<string, JsonValue> = {};
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
  };
}

function toHarnessRun(result: EvalResult): HarnessRun {
  const output = buildEvalOutput(result);
  const toolCalls = result.toolInvocations.map(toToolCallRecord);
  const messages: NormalizedMessage[] = [
    ...result.posts.map(
      (post): NormalizedMessage => ({
        role: "assistant",
        content: post.text,
        metadata: toJsonRecord({
          ...(post.channel ? { channel: post.channel } : {}),
          ...(post.thread_ts ? { thread_ts: post.thread_ts } : {}),
          files: post.files,
        }),
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

  return {
    output,
    session: {
      messages,
      outputText: serializeEvalOutput(output),
      metadata: toJsonRecord({
        slack_metadata: output.slack_metadata,
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
  contract: string;
  pass: readonly string[];
  allow?: readonly string[];
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
    `Contract:\n${criteria.contract}`,
    formatBulletSection("Pass", criteria.pass),
    formatBulletSection("Allow", criteria.allow),
    formatBulletSection("Fail", criteria.fail),
  ]
    .filter((section): section is string => section !== null)
    .join("\n\n");
}

function getEvalLabel(input: SlackEvalInput): string {
  return input.criteria.contract;
}

function assertGatewayReady(input: SlackEvalInput, result: EvalResult): void {
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
    `Eval gateway bootstrap failed for "${getEvalLabel(input)}". Received "${message}". ` +
      "Refresh AI Gateway auth first (for example via `vercel env pull`) and retry.",
  );
}

function assertSandboxReady(input: SlackEvalInput, result: EvalResult): void {
  const failingPosts = result.posts.filter((post) =>
    post.text.includes(SANDBOX_SETUP_FAILED_TEXT),
  );
  if (failingPosts.length === 0) {
    return;
  }

  const sample = failingPosts[0]?.text ?? SANDBOX_SETUP_FAILED_TEXT;
  throw new Error(
    `Eval sandbox bootstrap failed for "${getEvalLabel(input)}". Received "${sample}". ` +
      "Evals require a working Vercel Sandbox and do not permit local fallback.",
  );
}

function assertStatusCleared(input: SlackEvalInput, result: EvalResult): void {
  const lastByThread = new Map<string, string>();
  for (const call of result.slackAdapter.statusCalls) {
    const key = `${call.channelId}:${call.threadTs}`;
    lastByThread.set(key, call.text);
  }
  for (const [thread, text] of lastByThread) {
    if (text !== "") {
      throw new Error(
        `Eval "${getEvalLabel(input)}" left assistant status pending on thread ${thread}: "${text}". ` +
          "Every turn must clear the assistant status indicator before completing.",
      );
    }
  }
}

/** Builds a structured, maintainer-readable judge rubric for an eval case. */
export function rubric(criteria: EvalRubric): EvalRubric {
  if (criteria.contract.trim() === "") {
    throw new Error("Eval rubric contract must be a non-empty sentence.");
  }
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
  prompt: async (input, options) => {
    const { text } = await completeText({
      modelId: EVAL_JUDGE_MODEL_ID,
      system: options?.system,
      messages: [
        {
          role: "user",
          content: input,
          timestamp: Date.now(),
        },
      ],
      temperature: 0,
      metadata: options?.metadata,
    });
    return text;
  },
  run: async (input) => {
    const logRecords: EmittedLogRecord[] = [];
    const unregisterLogSink = registerLogRecordSink((record) => {
      logRecords.push(record);
    });
    try {
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
        assertGatewayReady(input, result);
      }
      if (input.requireSandboxReady ?? true) {
        assertSandboxReady(input, result);
      }
      assertStatusCleared(input, result);
      return toHarnessRun(result);
    } finally {
      unregisterLogSink();
    }
  },
};

/** Scores Slack eval output against the case rubric. */
export const RubricJudge = namedJudge(
  "RubricJudge",
  async ({
    inputValue,
    output,
    harness,
  }: JudgeContext<
    SlackEvalInput,
    Record<string, unknown>,
    typeof slackHarness
  >) => {
    const object = parseJudgeResult(
      await harness.prompt(
        formatJudgePrompt(output, formatRubric(inputValue.criteria)),
        {
          system: EVAL_SYSTEM,
          metadata: {
            judge: "RubricJudge",
          },
        },
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
  judges: [RubricJudge],
  judgeThreshold: 0.75,
} satisfies DescribeEvalOptions<SlackEvalInput>;

// ── Event builders ─────────────────────────────────────────

let _seq = 0;
function nextId() {
  return String(++_seq);
}

const DEFAULT_AUTHOR = {
  user_id: "U-test",
  user_name: "testuser",
  full_name: "Test User",
  is_me: false,
  is_bot: false,
};

type AuthorOverrides = Partial<typeof DEFAULT_AUTHOR>;

interface ThreadOverrides {
  id?: string;
  channel_id?: string;
  thread_ts?: string;
}

/** Builds a first-turn mention event for a harnessed Slack eval. */
export function mention(
  text: string,
  opts?: { author?: AuthorOverrides; thread?: ThreadOverrides },
) {
  const seq = nextId();
  return {
    type: "new_mention" as const,
    thread: {
      id: `thread-${seq}`,
      channel_id: `C-${seq}`,
      thread_ts: `17000000.${seq}`,
      ...opts?.thread,
    },
    message: {
      id: `m-${seq}`,
      text,
      is_mention: true,
      author: { ...DEFAULT_AUTHOR, ...opts?.author },
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
  return {
    type: "subscribed_message" as const,
    thread: {
      id: `thread-${seq}`,
      channel_id: `C-${seq}`,
      thread_ts: `17000000.${seq}`,
      ...opts?.thread,
    },
    message: {
      id: `m-${seq}`,
      text,
      is_mention: opts?.is_mention ?? false,
      author: { ...DEFAULT_AUTHOR, ...opts?.author },
    },
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
      channel_id: `C-${seq}`,
      thread_ts: `17000000.${seq}`,
      ...opts?.thread,
    },
    user_id: opts?.user_id ?? `U-${seq}`,
  };
}
