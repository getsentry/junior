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
    "resilience: streamed text does not end with a synthetic failure reply",
    {
      overrides: {
        reply_results: [
          {
            stream_text: "Budget is still on track for Friday.",
            text: "I couldn't complete this request in this turn due to an execution failure. I've logged the details for debugging.",
            outcome: "execution_failure",
            used_primary_text: true,
            assistant_message_count: 2,
            stop_reason: "stop",
          },
        ],
      },
      events: [mention("Quick budget update?")],
      criteria:
        "The assistant posts exactly one thread reply. That reply contains the budget update text. No additional fallback error reply appears, and assistant_posts does not contain execution-failure or logged-for-debugging text.",
    },
  );
});
