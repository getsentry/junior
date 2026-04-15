import { describe } from "vitest";
import { mention, slackEval, threadStart } from "../helpers";

describe("Conversational Evals: Lifecycle and Resilience", () => {
  slackEval("lifecycle: assistant thread init metadata", {
    events: [threadStart()],
    criteria:
      "No reply is posted. Thread title and suggested prompts are each set exactly once.",
  });

  slackEval("resilience: handler error is user-visible", {
    overrides: { fail_reply_call: 1 },
    events: [mention("What's the status of the deploy?")],
    criteria: "A single error reply is posted when response generation fails.",
  });

  slackEval(
    "resilience: streamed provider error keeps partial text and adds interruption notice",
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
      criteria:
        "assistant_posts contains exactly two entries. The first entry includes the budget update. The second entry clearly says the response was interrupted before completion. No entry in assistant_posts mentions execution failure or logged for debugging.",
    },
  );
});
