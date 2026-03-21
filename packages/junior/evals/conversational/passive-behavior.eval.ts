import { describe } from "vitest";
import { mention, slackEval, threadMessage } from "../helpers";

describe("Conversational Evals: Passive Behavior", () => {
  slackEval("passive: subscribed side conversation is skipped", {
    behavior: {
      subscribed_decisions: [
        { should_reply: false, reason: "side conversation" },
      ],
    },
    events: [threadMessage("thanks everyone")],
    criteria:
      "The assistant posts no reply when subscribed-thread routing decides the message is just side conversation.",
  });

  slackEval("passive: acknowledgment-only subscribed message is skipped", {
    events: [threadMessage("thanks!")],
    criteria:
      "The assistant posts no reply for acknowledgment-only subscribed thread messages that are not explicit mentions.",
  });

  const optOutThread = {
    id: "thread-opt-out",
    channel_id: "C-opt-out",
    thread_ts: "17000000.optout",
  };

  slackEval("passive: explicit stop request opts out until re-mentioned", {
    behavior: {
      live_subscribed_routing: true,
      reply_texts: [
        "I can help in this thread.",
        "I'm back because you mentioned me again.",
      ],
    },
    events: [
      mention("Can you help in this thread?", { thread: optOutThread }),
      threadMessage("<@U_APP> stop watching or participating in this thread", {
        thread: optOutThread,
        is_mention: true,
      }),
      mention("Actually jump back in.", { thread: optOutThread }),
    ],
    criteria:
      "The assistant posts exactly three visible replies in order: first a normal helpful reply, second a short acknowledgment that it will stay out of the thread unless mentioned again, and third a fresh reply only after the later direct mention. The stop message is not treated like an ordinary help request.",
  });
});
