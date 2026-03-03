import { configure, evaluate } from "vitest-evals/evaluate";
import { gateway } from "@ai-sdk/gateway";
import { z } from "zod";
import {
  type BehaviorCaseConfig,
  type BehaviorCaseEvent,
  type BehaviorCaseResult,
  runBehaviorEvalCase,
} from "./behavior-harness";

configure({ model: gateway("openai/gpt-5.2") });

// ── Eval output schema ─────────────────────────────────────

const slackMetadataSchema = z.object({
  thread_title_set: z.boolean().describe("Whether the assistant set a title on the Slack thread"),
  suggested_prompts_set: z.boolean().describe("Whether the assistant set suggested prompts on the Slack thread"),
});

const evalOutputSchema = z.object({
  assistant_posts: z.array(z.string()).describe("Messages the assistant posted to the thread"),
  channel_posts: z
    .array(
      z.object({
        channel: z.string().describe("Slack channel ID where a direct channel post was sent"),
        text: z.string().describe("Message text sent via Slack chat.postMessage"),
        thread_ts: z.string().optional().describe("Slack thread timestamp when the message was sent as a thread reply")
      })
    )
    .describe("Slack channel posts sent outside the thread-reply surface"),
  slack_metadata: slackMetadataSchema.describe("Slack thread metadata set by the assistant"),
});

function serializeResult(result: BehaviorCaseResult): string {
  const output: z.input<typeof evalOutputSchema> = {
    assistant_posts: result.posts,
    channel_posts: result.channelPosts,
    slack_metadata: {
      thread_title_set: result.slackAdapter.titleCalls.length > 0,
      suggested_prompts_set: result.slackAdapter.promptCalls.length > 0,
    },
  };
  return JSON.stringify(output);
}

// ── Core eval wrapper ──────────────────────────────────────

interface SlackEvalOptions {
  behavior?: BehaviorCaseConfig;
  events: BehaviorCaseEvent[];
  criteria: string;
  threshold?: number;
  timeout?: number;
  requireSandboxReady?: boolean;
}

const SANDBOX_SETUP_FAILED_TEXT = "Error: sandbox setup failed";

function assertSandboxReady(name: string, result: BehaviorCaseResult): void {
  const failingPosts = result.posts.filter((post) => post.includes(SANDBOX_SETUP_FAILED_TEXT));
  if (failingPosts.length === 0) {
    return;
  }

  const sample = failingPosts[0];
  throw new Error(
    `Eval sandbox bootstrap failed for "${name}". Received "${sample}". ` +
      "Evals require a working Vercel Sandbox and do not permit local fallback."
  );
}

export function slackEval(name: string, opts: SlackEvalOptions) {
  evaluate(name, {
    timeout: opts.timeout ?? 120_000,
    threshold: opts.threshold ?? 0.75,
    task: async () => {
      const result = await runBehaviorEvalCase({
        behavior: opts.behavior,
        events: opts.events,
      });
      if (opts.requireSandboxReady ?? true) {
        assertSandboxReady(name, result);
      }
      return serializeResult(result);
    },
    criteria: opts.criteria,
  });
}

// ── Event builders ─────────────────────────────────────────

let _seq = 0;
function nextId() { return String(++_seq); }

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

export function mention(text: string, opts?: { thread?: ThreadOverrides }) {
  const seq = nextId();
  return {
    type: "new_mention" as const,
    thread: { id: `thread-${seq}`, channel_id: `C-${seq}`, thread_ts: `17000000.${seq}`, ...opts?.thread },
    message: { id: `m-${seq}`, text, is_mention: true, author: { ...DEFAULT_AUTHOR } },
  };
}

export function threadMessage(text: string, opts?: { thread?: ThreadOverrides; is_mention?: boolean }) {
  const seq = nextId();
  return {
    type: "subscribed_message" as const,
    thread: { id: `thread-${seq}`, channel_id: `C-${seq}`, thread_ts: `17000000.${seq}`, ...opts?.thread },
    message: { id: `m-${seq}`, text, is_mention: opts?.is_mention ?? false, author: { ...DEFAULT_AUTHOR } },
  };
}

export function threadStart(opts?: { thread?: ThreadOverrides; user_id?: string }) {
  const seq = nextId();
  return {
    type: "assistant_thread_started" as const,
    thread: { id: `thread-${seq}`, channel_id: `C-${seq}`, thread_ts: `17000000.${seq}`, ...opts?.thread },
    user_id: opts?.user_id ?? `U-${seq}`,
  };
}
