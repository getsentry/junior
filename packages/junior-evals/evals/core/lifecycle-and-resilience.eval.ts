import { describeEval } from "vitest-evals";
import { mention, rubric, slackEvals, threadStart } from "../../src/helpers";

describeEval("Lifecycle and Resilience", slackEvals, (it) => {
  it("when an assistant thread starts, set title and prompts without posting a reply", async ({
    run,
  }) => {
    await run({
      initialEvents: [threadStart()],
      criteria: rubric({
        pass: [
          "No assistant reply is posted.",
          "The thread title is set exactly once.",
          "Suggested prompts are set exactly once.",
        ],
      }),
    });
  });

  it("when reply generation fails before any answer, post one clear error reply", async ({
    run,
  }) => {
    await run({
      overrides: { fail_reply_call: 1 },
      initialEvents: [mention("What's the status of the deploy?")],
      criteria: rubric({
        pass: [
          "The normalized transcript contains exactly one assistant thread reply.",
          "That reply clearly tells the user the request failed in user-facing language.",
        ],
        fail: [
          "Do not leak stack traces, exception text, or debugging narration in the reply.",
        ],
      }),
    });
  });

  it("when a short reply is interrupted by the provider, keep the partial answer in one marked post", async ({
    run,
  }) => {
    await run({
      overrides: {
        reply_results: [
          {
            stream_text: "Budget is still on track for Friday.",
            text: "Budget is still on track for Friday.",
            outcome: "provider_error",
          },
        ],
      },
      initialEvents: [mention("Quick budget update?")],
      criteria: rubric({
        pass: [
          "The normalized transcript contains exactly one assistant thread reply because this answer fits in a single Slack post.",
          "That reply includes the budget update that it is still on track for Friday.",
          "That same reply clearly says the response was interrupted before completion.",
        ],
        fail: [
          "Do not require a second Slack reply for this short answer.",
          "Do not mention provider internals, execution failure details, or logged-for-debugging text.",
        ],
      }),
    });
  });
});
