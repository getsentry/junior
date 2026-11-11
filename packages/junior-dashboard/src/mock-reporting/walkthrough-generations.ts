/**
 * Generation Conversations for the mock Walkthroughs. The cost on the
 * Walkthrough page links to one, so its transcript and usage breakdown can be
 * checked without running a generation.
 */
import type { ConversationReportEvent } from "@sentry/junior/api/schema";

/** One generation Conversation per ready mock Walkthrough. */
export const MOCK_GENERATION_CONVERSATION_IDS = {
  single: "local:web:walkthrough-generation-3071",
  stack: "local:web:walkthrough-generation-3089",
} as const;

const GENERATION_IDS: ReadonlySet<string> = new Set(
  Object.values(MOCK_GENERATION_CONVERSATION_IDS),
);

/** Return whether this id is a mock generation, which lists hide. */
export function isMockGenerationConversation(conversationId: string): boolean {
  return GENERATION_IDS.has(conversationId);
}

const MODEL_ID = "anthropic/claude-opus-4.5";

function usage(args: {
  input: number;
  cached: number;
  output: number;
  costUsd: number;
}) {
  return {
    inputTokens: args.input,
    cachedInputTokens: args.cached,
    outputTokens: args.output,
    cost: {
      input: args.costUsd * 0.7,
      output: args.costUsd * 0.3,
      total: args.costUsd,
    },
  };
}

function event(
  seq: number,
  createdAt: string,
  data: ConversationReportEvent["data"],
): ConversationReportEvent {
  return { seq, createdAt, data };
}

function toolCall(
  name: string,
  input: Record<string, unknown>,
  output: string,
  id: string,
) {
  return { input, name, output, status: "completed" as const, toolCallId: id };
}

/**
 * Build both generation Conversations. Each one reads the stack, checks a
 * file, and submits the Walkthrough, as a live generation Turn does.
 */
export function mockGenerationConversations(nowMs: number) {
  const at = (minutes: number) =>
    new Date(nowMs - minutes * 60_000).toISOString();
  const generation = (args: {
    conversationId: string;
    displayTitle: string;
    prs: number[];
    costUsd: number;
    input: number;
    cached: number;
    output: number;
    startedMinutesAgo: number;
    durationMs: number;
  }) => {
    const start = args.startedMinutesAgo;
    const turnId = `${args.conversationId}:turn`;
    const top = args.prs.at(-1)!;
    const cumulativeUsage = usage(args);
    const events = [
      event(0, at(start), {
        type: "message",
        messageId: `${args.conversationId}:request`,
        role: "user",
        text: `$walkthrough getsentry/junior#${top}`,
      }),
      event(1, at(start - 0.1), {
        type: "turn_lifecycle",
        turnId,
        state: "started",
      }),
      event(2, at(start - 0.5), {
        type: "tool_calls",
        calls: [
          toolCall(
            "readCodeChangeStack",
            { repository: "getsentry/junior", number: top },
            JSON.stringify({ layers: args.prs }),
            `${turnId}:stack`,
          ),
          ...args.prs.map((pr) =>
            toolCall(
              "readCodeChangeDiff",
              { repository: "getsentry/junior", number: pr },
              JSON.stringify({ files: 4 }),
              `${turnId}:diff-${pr}`,
            ),
          ),
        ],
      }),
      event(3, at(start - 2), {
        type: "tool_calls",
        calls: [
          toolCall(
            "submitWalkthrough",
            { chapters: args.prs.length * 2 + 2 },
            JSON.stringify({
              ok: false,
              problems: ["A hunk is neither cited nor in not_covered."],
            }),
            `${turnId}:submit-1`,
          ),
        ],
      }),
      event(4, at(start - 3), {
        type: "tool_calls",
        calls: [
          toolCall(
            "submitWalkthrough",
            { chapters: args.prs.length * 2 + 2 },
            JSON.stringify({ ok: true }),
            `${turnId}:submit-2`,
          ),
        ],
      }),
      event(5, at(start - 3.1), {
        type: "message",
        messageId: `${args.conversationId}:reply`,
        role: "assistant",
        text: "The Walkthrough is stored. Every citation resolved on the second try.",
      }),
      event(6, at(start - 3.1), {
        type: "turn_lifecycle",
        turnId,
        state: "succeeded",
      }),
    ];
    return {
      actorIdentity: { email: "junior@sentry.io", fullName: "Junior" },
      conversationId: args.conversationId,
      cumulativeDurationMs: args.durationMs,
      cumulativeUsage,
      displayTitle: args.displayTitle,
      events,
      lastProgressAt: events.at(-1)!.createdAt,
      lastSeenAt: events.at(-1)!.createdAt,
      modelUsage: [{ modelId: MODEL_ID, usage: cumulativeUsage }],
      startedAt: events[0]!.createdAt,
      surface: "api" as const,
      visibility: "public" as const,
    };
  };
  return [
    generation({
      conversationId: MOCK_GENERATION_CONVERSATION_IDS.single,
      displayTitle: "Walkthrough of getsentry/junior#3071",
      prs: [3071],
      // The same cost as the Walkthrough fixture, so the two match.
      costUsd: 0.5317994,
      input: 312_400,
      cached: 248_100,
      output: 9_800,
      startedMinutesAgo: 90,
      durationMs: 182_000,
    }),
    generation({
      conversationId: MOCK_GENERATION_CONVERSATION_IDS.stack,
      displayTitle: "Walkthrough of getsentry/junior#3133",
      prs: [3087, 3088, 3090, 3124, 3133],
      costUsd: 2.2965502,
      input: 1_384_000,
      cached: 1_102_500,
      output: 41_300,
      startedMinutesAgo: 70,
      durationMs: 475_000,
    }),
  ];
}
