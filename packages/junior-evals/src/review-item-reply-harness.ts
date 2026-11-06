/**
 * Isolated harness for the decision that matches a thread reply to the open
 * Review items it answers.
 *
 * Calls the real `matchReplyToReviewItems` with the configured decision
 * model. It does not run the agent, Slack ingress, Postgres, or Redis.
 */
import {
  createHarness,
  type DescribeEvalOptions,
  type JsonValue,
} from "vitest-evals";
import { botConfig } from "@/chat/config";
import {
  matchReplyToReviewItems,
  type ReplyMatchItem,
} from "@/chat/review-items/reply-match";

interface ReviewItemReplyEvalInput {
  /** Ids of the items that the reply answers. */
  expected: string[];
  /** Open items in the thread, in the order the agent added them. */
  items: ReplyMatchItem[];
  reply: string;
}

interface ReviewItemReplyEvalOutput extends Record<string, JsonValue> {
  expected: string[];
  matched: string[];
}

/** Lightweight vitest-evals harness for exact reply match cases. */
export const reviewItemReplyHarness = createHarness<
  ReviewItemReplyEvalInput,
  ReviewItemReplyEvalOutput
>({
  name: "review-item-reply",
  run: async ({ input }) => {
    const ids = await matchReplyToReviewItems({
      conversationId: "slack:CEVAL:1712345.0001",
      items: input.items,
      text: input.reply,
    });
    const order = (values: Iterable<string>) => [...values].sort();
    const matched = order(ids);
    const expected = order(input.expected);
    if (JSON.stringify(matched) !== JSON.stringify(expected)) {
      throw new Error(
        `Reply matched [${matched.join(", ")}]; expected [${expected.join(", ")}]`,
      );
    }
    return {
      output: { expected, matched },
      events: [
        {
          type: "message",
          role: "user",
          content: input.reply,
        },
        {
          type: "message",
          role: "assistant",
          content: `Answers: ${matched.join(", ") || "none"}`,
        },
      ],
      usage: {
        provider: "vercel-ai-gateway",
        model: botConfig.decisionModelId,
      },
    };
  },
});

/** Shared vitest-evals suite options for exact reply match evals. */
export const reviewItemReplyEvals = {
  harness: reviewItemReplyHarness,
  judges: [],
  judgeThreshold: null,
} satisfies DescribeEvalOptions<
  ReviewItemReplyEvalInput,
  ReviewItemReplyEvalOutput,
  typeof reviewItemReplyHarness
>;
