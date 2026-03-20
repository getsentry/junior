import { describe } from "vitest";
import { mention, slackEval, threadStart } from "../helpers";

describe("Conversational Evals: Lifecycle and Resilience", () => {
  slackEval("lifecycle: assistant thread init metadata", {
    events: [threadStart()],
    criteria:
      "No reply is posted. Thread title and suggested prompts are each set exactly once.",
  });

  slackEval("resilience: handler error is user-visible", {
    behavior: { fail_reply_call: 1 },
    events: [mention("What's the status of the deploy?")],
    criteria: "A single error reply is posted when response generation fails.",
  });

  slackEval("resilience: retryable timeout-shaped failure retries cleanly", {
    behavior: {
      retryable_timeout_calls: [1],
      retryable_max_attempts: 2,
    },
    events: [mention("What's the status of the deploy?")],
    criteria:
      "The assistant posts one non-error answer after retry and does not post an Error-prefixed failure message.",
  });
});
