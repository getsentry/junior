import { describe } from "vitest";
import { mention, slackEval, threadMessage } from "../helpers";

describe("Conversational Evals: Passive Behavior", () => {
  const sideConversationThread = {
    id: "thread-passive-side-conversation",
    channel_id: "C-passive-side-conversation",
    thread_ts: "17000000.passive-side-conversation",
  };

  slackEval("passive: human follow-up question is skipped", {
    overrides: {
      reply_texts: [
        "The deploy changed the billing worker and the API auth flow.",
      ],
    },
    events: [
      mention(
        "Summarize this deploy in one sentence. It changed the billing worker and the API auth flow.",
        {
          thread: sideConversationThread,
        },
      ),
      threadMessage("@sam can you take the billing worker rollback?", {
        thread: sideConversationThread,
      }),
    ],
    criteria:
      "The assistant posts exactly one reply: the initial helpful answer about the deploy. It does not answer the later human-to-human question addressed to @sam about who should take the rollback, even though that later message is phrased as a question.",
  });

  const directedFollowUpThread = {
    id: "thread-passive-directed-follow-up",
    channel_id: "C-passive-directed-follow-up",
    thread_ts: "17000000.passive-directed-follow-up",
  };

  slackEval("passive: follow-up to Junior response gets a reply", {
    overrides: {
      reply_texts: ["You need the budget by Friday."],
    },
    events: [
      mention("I need the budget by Friday.", {
        thread: directedFollowUpThread,
      }),
      threadMessage("What did you just say about the budget?", {
        thread: directedFollowUpThread,
      }),
    ],
    criteria:
      "The assistant posts two replies in order. The second reply plainly restates that the budget is needed by Friday because the follow-up is clearly directed at Junior's previous response, even without another @mention.",
  });

  const optOutThread = {
    id: "thread-opt-out",
    channel_id: "C-opt-out",
    thread_ts: "17000000.optout",
  };

  slackEval("passive: explicit stop request opts out until re-mentioned", {
    overrides: {
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
