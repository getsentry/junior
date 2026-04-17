import { describe } from "vitest";
import { mention, rubric, slackEval, threadStart } from "../helpers";

describe("Lifecycle and Resilience", () => {
  slackEval(
    "when an assistant thread starts, set title and prompts without posting a reply",
    {
      events: [threadStart()],
      criteria: rubric({
        contract:
          "The assistant initializes Slack thread metadata without posting a visible reply.",
        pass: [
          "No assistant reply is posted.",
          "The thread title is set exactly once.",
          "Suggested prompts are set exactly once.",
        ],
      }),
    },
  );

  slackEval(
    "when reply generation fails before any answer, post one clear error reply",
    {
      overrides: { fail_reply_call: 1 },
      events: [mention("What's the status of the deploy?")],
      criteria: rubric({
        contract:
          "When reply generation fails before any answer is posted, the user still gets one clear failure reply.",
        pass: [
          "assistant_posts contains exactly one reply.",
          "That reply clearly tells the user the request failed in user-facing language.",
        ],
        fail: [
          "Do not leak stack traces, exception text, or debugging narration in the reply.",
        ],
      }),
    },
  );

  slackEval(
    "when a short reply is interrupted by the provider, keep the partial answer in one marked post",
    {
      overrides: {
        reply_results: [
          {
            stream_text: "Budget is still on track for Friday.",
            text: "Budget is still on track for Friday.",
            outcome: "provider_error",
          },
        ],
      },
      events: [mention("Quick budget update?")],
      criteria: rubric({
        contract:
          "A provider interruption preserves the partial answer and marks that same reply as interrupted.",
        pass: [
          "assistant_posts contains exactly one reply because this answer fits in a single Slack post.",
          "That reply includes the budget update that it is still on track for Friday.",
          "That same reply clearly says the response was interrupted before completion.",
        ],
        fail: [
          "Do not require a second Slack reply for this short answer.",
          "Do not mention provider internals, execution failure details, or logged-for-debugging text.",
        ],
      }),
    },
  );
});
