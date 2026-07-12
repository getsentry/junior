import { assistantMessages, describeEval } from "vitest-evals";
import { expect } from "vitest";
import {
  mention,
  rubric,
  slackEvals,
  slackSideEffects,
  threadStart,
} from "../../src/helpers";

type EvalSession = Parameters<typeof assistantMessages>[0];

function textContent(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function visibleThreadReplies(session: EvalSession) {
  return assistantMessages(session).filter(
    (message) =>
      message.metadata?.event_type === "thread_post" &&
      textContent(message.content).trim().length > 0,
  );
}

describeEval("Lifecycle and Resilience", slackEvals, (it) => {
  it("when an assistant thread starts, set title and prompts without posting a reply", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [threadStart()],
      criteria: rubric({
        pass: ["No assistant reply is posted."],
      }),
    });

    expect(visibleThreadReplies(result.session)).toHaveLength(0);
    expect(slackSideEffects(result)).toMatchObject({
      suggestedPromptCalls: 1,
      threadTitleCalls: 1,
    });
  });

  it("when reply generation fails before any answer, post one clear error reply", async ({
    run,
  }) => {
    const result = await run({
      overrides: { fail_reply_call: 1 },
      initialEvents: [mention("What's the status of the deploy?")],
      criteria: rubric({
        pass: [
          "That reply clearly tells the user the request failed in user-facing language.",
        ],
        fail: [
          "Do not leak stack traces, exception text, or debugging narration in the reply.",
        ],
      }),
    });

    expect(visibleThreadReplies(result.session)).toHaveLength(1);
  });

  it("when a short reply is interrupted by the provider, keep the partial answer in one marked post", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        reply_results: [
          {
            stream_text: "Budget is still on track for Friday.",
            text: "Budget is still on track for Friday.",
            outcome: "provider_error",
            usage: {
              inputTokens: 120,
              outputTokens: 20,
              cachedInputTokens: 300,
              cacheCreationTokens: 40,
              reasoningTokens: 5,
              totalTokens: 480,
              cost: {
                input: 0.001,
                output: 0.002,
                cacheRead: 0.0003,
                cacheWrite: 0.0004,
                total: 0.0037,
              },
            },
          },
        ],
      },
      initialEvents: [mention("Quick budget update?")],
      criteria: rubric({
        pass: [
          "That reply includes the budget update that it is still on track for Friday.",
          "That same reply clearly says the response was interrupted before completion.",
        ],
        fail: [
          "Do not require a second Slack reply for this short answer.",
          "Do not mention provider internals, execution failure details, or logged-for-debugging text.",
        ],
      }),
    });
    expect(visibleThreadReplies(result.session)).toHaveLength(1);
    expect(result.usage).toMatchObject({
      provider: "vercel-ai-gateway",
      model: "eval-reply-result",
      inputTokens: 120,
      outputTokens: 20,
      reasoningTokens: 5,
      totalTokens: 480,
      metadata: {
        cachedInputTokens: 300,
        cacheCreationTokens: 40,
        cost: {
          input: 0.001,
          output: 0.002,
          cacheRead: 0.0003,
          cacheWrite: 0.0004,
          total: 0.0037,
        },
        costUsd: 0.0037,
        currency: "USD",
      },
    });
  });
});
