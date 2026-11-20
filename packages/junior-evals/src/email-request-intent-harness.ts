/**
 * Isolated harness for the decision-model check that the Google plugin runs
 * on an email that only CCs the bot's account.
 *
 * Calls the real `emailAsksAccount` with the decision model that the Google
 * plugin heartbeat gets. It does not run the agent, Gmail, Postgres, or
 * Redis.
 */
import {
  createHarness,
  type DescribeEvalOptions,
  type JsonValue,
} from "vitest-evals";
import { botConfig } from "@/chat/config";
import { createPluginDecider } from "@/chat/plugins/model";
import { emailAsksAccount } from "../../junior-google/src/email/intent";

interface EmailRequestIntentInput {
  /** The sender's first Message, as the heartbeat renders it. */
  message: string;
  /** Whether the sender asks the bot to do something. */
  asks: boolean;
}

interface EmailRequestIntentOutput extends Record<string, JsonValue> {
  asks: boolean;
}

/** Account address in every case. */
export const EMAIL_REQUEST_ACCOUNT = "junior@example.com";

/** Lightweight vitest-evals harness for email request intent cases. */
export const emailRequestIntentHarness = createHarness<
  EmailRequestIntentInput,
  EmailRequestIntentOutput
>({
  name: "email-request-intent",
  run: async ({ input }) => {
    const asks = await emailAsksAccount(createPluginDecider("google"), {
      accountEmail: EMAIL_REQUEST_ACCOUNT,
      message: input.message,
    });
    if (asks !== input.asks) {
      throw new Error(
        `Email intent check said ${asks ? "asks" : "informs"}, expected ${input.asks ? "asks" : "informs"}.`,
      );
    }
    return {
      output: { asks },
      events: [
        { type: "message", role: "user", content: input.message },
        {
          type: "message",
          role: "assistant",
          content: asks ? "asks" : "informs",
        },
      ],
      usage: {
        provider: "vercel-ai-gateway",
        model: botConfig.decisionModelId,
      },
    };
  },
});

/** Shared vitest-evals suite options for email request intent evals. */
export const emailRequestIntentEvals = {
  harness: emailRequestIntentHarness,
  // The harness checks the exact choice; no rubric judge.
  judges: [],
  judgeThreshold: null,
} satisfies DescribeEvalOptions<
  EmailRequestIntentInput,
  EmailRequestIntentOutput,
  typeof emailRequestIntentHarness
>;
