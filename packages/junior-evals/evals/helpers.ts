import { configure, evaluate } from "vitest-evals/evaluate";
import { gateway } from "@ai-sdk/gateway";
import { z } from "zod";
import { registerLogRecordSink, type EmittedLogRecord } from "@/chat/logging";
import {
  type EvalEvent,
  type EvalOverrides,
  type EvalResult,
  runEvalScenario,
} from "./behavior-harness";

configure({ model: gateway("openai/gpt-5.2") });

// ── Eval output schema ─────────────────────────────────────

const slackMetadataSchema = z.object({
  thread_title_set: z
    .boolean()
    .describe("Whether the assistant set a title on the Slack thread"),
  suggested_prompts_set: z
    .boolean()
    .describe(
      "Whether the assistant set suggested prompts on the Slack thread",
    ),
  assistant_status_pending: z
    .boolean()
    .describe(
      "Whether any assistant thread still has a non-empty status indicator after the turn completed (should always be false)",
    ),
});

const attachedFileSchema = z.object({
  filename: z
    .string()
    .describe("Filename of an actual file attached to the assistant post"),
  isImage: z.boolean().describe("Whether the attached file is an image"),
  mimeType: z
    .string()
    .optional()
    .describe("MIME type of the attached file when known"),
  sizeBytes: z
    .number()
    .optional()
    .describe("File size in bytes when the harness has the binary payload"),
});

const assistantPostSchema = z.object({
  files: z
    .array(attachedFileSchema)
    .describe(
      "Actual files attached to this assistant thread post, not text describing files",
    ),
  text: z.string().describe("Visible text the assistant posted in the thread"),
});

const canvasSchema = z.object({
  title: z.string().describe("Title of a Slack canvas created during the turn"),
  markdown: z
    .string()
    .describe(
      "Initial markdown body written into the created Slack canvas during the turn",
    ),
});

const evalOutputSchema = z.object({
  assistant_posts: z
    .array(assistantPostSchema)
    .describe("Assistant posts sent to the thread, including attached files"),
  canvases: z
    .array(canvasSchema)
    .describe("Slack canvases created during the turn"),
  channel_posts: z
    .array(
      z.object({
        channel: z
          .string()
          .describe("Slack channel ID where a direct channel post was sent"),
        text: z
          .string()
          .describe("Message text sent via Slack chat.postMessage"),
        thread_ts: z
          .string()
          .optional()
          .describe(
            "Slack thread timestamp when the message was sent as a thread reply",
          ),
      }),
    )
    .describe("Slack channel posts sent outside the thread-reply surface"),
  reactions: z
    .array(
      z.object({
        channel: z
          .string()
          .describe("Slack channel ID where the reaction was added"),
        emoji: z
          .string()
          .describe("Emoji reaction name sent via Slack reactions.add"),
        timestamp: z
          .string()
          .describe(
            "Target message timestamp reacted to via Slack reactions.add",
          ),
      }),
    )
    .describe("Slack reactions added by the assistant"),
  slack_metadata: slackMetadataSchema.describe(
    "Slack thread metadata set by the assistant",
  ),
});

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

function collectExplicitProgressMessages(result: EvalResult): string[] {
  const explicitMessages: string[] = [];
  const sawInitialStatusByThread = new Set<string>();

  for (const call of result.slackAdapter.statusCalls) {
    const threadKey = `${call.channelId}:${call.threadTs}`;
    const text = call.text.trim();
    const loadingMessages =
      call.loadingMessages
        ?.map((message) => message.trim())
        .filter((message) => message.length > 0) ?? [];
    if (!text) {
      continue;
    }
    if (!sawInitialStatusByThread.has(threadKey)) {
      sawInitialStatusByThread.add(threadKey);
      continue;
    }
    if (loadingMessages.length !== 1) {
      continue;
    }
    const message = loadingMessages[0];
    if (!message) {
      continue;
    }
    if (!explicitMessages.includes(message)) {
      explicitMessages.push(message);
    }
  }

  return explicitMessages;
}

const GENERIC_PROGRESS_MESSAGES = new Set([
  "checking",
  "loading",
  "processing",
  "thinking",
  "working",
]);

const MEANINGFUL_PROGRESS_PHASE =
  /\b(analy|check|compare|draft|fetch|inspect|look|query|read|research|review|run|search|summari|verify|write)\w*\b/i;

function isMeaningfulProgressMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized || GENERIC_PROGRESS_MESSAGES.has(normalized)) {
    return false;
  }
  return /\s/.test(normalized) || MEANINGFUL_PROGRESS_PHASE.test(normalized);
}

/** Assert that a turn emitted a specific non-generic explicit progress phase. */
export function assertMeaningfulExplicitProgress(
  name: string,
  result: EvalResult,
): void {
  const messages = collectExplicitProgressMessages(result);
  if (messages.length === 0) {
    throw new Error(
      `Eval "${name}" never emitted an explicit progress phase beyond the generic loading state.`,
    );
  }

  if (messages.some(isMeaningfulProgressMessage)) {
    return;
  }

  throw new Error(
    `Eval "${name}" only emitted generic explicit progress messages: ${messages.join(", ")}.`,
  );
}

function serializeEvalResult(result: EvalResult): string {
  const output: z.input<typeof evalOutputSchema> = {
    assistant_posts: result.posts,
    canvases: result.canvases,
    channel_posts: result.channelPosts,
    reactions: result.reactions,
    slack_metadata: {
      thread_title_set: result.slackAdapter.titleCalls.length > 0,
      suggested_prompts_set: result.slackAdapter.promptCalls.length > 0,
      assistant_status_pending: hasAssistantStatusPending(result),
    },
  };
  return JSON.stringify(output, null, 2);
}

// ── Core eval wrapper ──────────────────────────────────────

interface EvalRubric {
  contract: string;
  pass: readonly string[];
  allow?: readonly string[];
  fail?: readonly string[];
}

interface SlackEvalOptions {
  events: EvalEvent[];
  overrides?: EvalOverrides;
  criteria: EvalRubric;
  assertResult?: (name: string, result: EvalResult) => void;
  requireGatewayReady?: boolean;
  taskTimeout?: number;
  threshold?: number;
  timeout?: number;
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

function assertGatewayReady(name: string, result: EvalResult): void {
  const failure = result.logRecords.find((record) => {
    if (record.eventName !== "ai_completion_failed") {
      return false;
    }
    const errorMessage = String(record.attributes["error.message"] ?? "");
    return GATEWAY_AUTH_FAILURE_PATTERNS.some((pattern) =>
      errorMessage.includes(pattern),
    );
  });
  if (!failure) {
    return;
  }

  const message =
    String(failure.attributes["error.message"] ?? "").trim() ||
    failure.body ||
    "AI Gateway authentication failed";
  throw new Error(
    `Eval gateway bootstrap failed for "${name}". Received "${message}". ` +
      "Refresh AI Gateway auth first (for example via `vercel env pull`) and retry.",
  );
}

function assertSandboxReady(name: string, result: EvalResult): void {
  const failingPosts = result.posts.filter((post) =>
    post.text.includes(SANDBOX_SETUP_FAILED_TEXT),
  );
  if (failingPosts.length === 0) {
    return;
  }

  const sample = failingPosts[0]?.text ?? SANDBOX_SETUP_FAILED_TEXT;
  throw new Error(
    `Eval sandbox bootstrap failed for "${name}". Received "${sample}". ` +
      "Evals require a working Vercel Sandbox and do not permit local fallback.",
  );
}

function assertStatusCleared(name: string, result: EvalResult): void {
  const lastByThread = new Map<string, string>();
  for (const call of result.slackAdapter.statusCalls) {
    const key = `${call.channelId}:${call.threadTs}`;
    lastByThread.set(key, call.text);
  }
  for (const [thread, text] of lastByThread) {
    if (text !== "") {
      throw new Error(
        `Eval "${name}" left assistant status pending on thread ${thread}: "${text}". ` +
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

/** Defines one end-to-end conversational eval case for the Slack harness. */
export function slackEval(name: string, opts: SlackEvalOptions) {
  evaluate(name, {
    timeout: opts.timeout ?? 120_000,
    threshold: opts.threshold ?? 0.75,
    task: async () => {
      const logRecords: EmittedLogRecord[] = [];
      const unregisterLogSink = registerLogRecordSink((record) => {
        logRecords.push(record);
      });
      try {
        const taskPromise = runEvalScenario(
          {
            events: opts.events,
            overrides: opts.overrides,
          },
          { logRecords },
        );
        const result =
          typeof opts.taskTimeout === "number" && opts.taskTimeout > 0
            ? await Promise.race([
                taskPromise,
                new Promise<never>((_, reject) =>
                  setTimeout(
                    () =>
                      reject(
                        new Error(
                          `Eval harness timed out after ${opts.taskTimeout}ms before judge evaluation`,
                        ),
                      ),
                    opts.taskTimeout,
                  ),
                ),
              ])
            : await taskPromise;
        if (opts.requireGatewayReady ?? true) {
          assertGatewayReady(name, result);
        }
        if (opts.requireSandboxReady ?? true) {
          assertSandboxReady(name, result);
        }
        assertStatusCleared(name, result);
        opts.assertResult?.(name, result);
        return serializeEvalResult(result);
      } finally {
        unregisterLogSink();
      }
    },
    criteria: formatRubric(opts.criteria),
  });
}

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

interface ThreadOverrides {
  id?: string;
  channel_id?: string;
  thread_ts?: string;
}

/** Builds a first-turn mention event for a harnessed Slack eval. */
export function mention(text: string, opts?: { thread?: ThreadOverrides }) {
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
      author: { ...DEFAULT_AUTHOR },
    },
  };
}

/** Builds a follow-up subscribed-thread message for a harnessed Slack eval. */
export function threadMessage(
  text: string,
  opts?: { thread?: ThreadOverrides; is_mention?: boolean },
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
      author: { ...DEFAULT_AUTHOR },
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
