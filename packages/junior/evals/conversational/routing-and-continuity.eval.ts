import { describe } from "vitest";
import { mention, slackEval, threadMessage } from "../helpers";

describe("Conversational Evals: Routing and Continuity", () => {
  slackEval("routing: explicit mention forces reply", {
    events: [threadMessage("<@U_APP> what is 2+2?", { is_mention: true })],
    criteria:
      "The assistant posts exactly one reply, answers with 4, and does not respond with sandbox setup failure text.",
  });

  slackEval("routing: explicit in-channel post request uses channel post", {
    events: [mention("@bot say hello to the channel!")],
    criteria:
      "The assistant sends the hello message as a channel post (channel_posts has exactly one item with hello/wave-style text and no thread_ts). It does not post hello/wave text as a thread reply in assistant_posts. An optional lightweight acknowledgement reaction in reactions is acceptable.",
  });

  slackEval("routing: react to this adds reaction without redundant reply", {
    events: [mention("react to this")],
    criteria:
      "The assistant adds at least one reaction in reactions. " +
      "No redundant thread reply echoing the emoji or a short ack like 'Done' appears in assistant_posts.",
  });

  const continuityThread = {
    id: "thread-continuity",
    channel_id: "C-continuity",
    thread_ts: "17000000.continuity",
  };

  slackEval("continuity: remembers prior turn context", {
    events: [
      mention("I need the budget by Friday.", { thread: continuityThread }),
      threadMessage("what did i just ask?", {
        thread: continuityThread,
        is_mention: true,
      }),
    ],
    criteria:
      "The assistant posts two replies in-order. The second reply explicitly references the prior context (budget and/or Friday) and does not include sandbox setup failure text.",
  });

  const rapidThread = {
    id: "thread-rapid",
    channel_id: "C-rapid",
    thread_ts: "17000000.rapid",
  };

  slackEval("continuity: rapid same-thread messages keep order", {
    overrides: {
      reply_texts: [
        "Rollback complete. Error rates are back to baseline.",
        "Next step: monitor dashboards for 30 minutes and post an incident summary.",
      ],
    },
    events: [
      mention(
        "We rolled back the deploy after a 500 spike. Give me a short status update.",
        { thread: rapidThread },
      ),
      threadMessage(
        "<@U_APP> Also give one concrete next step for incident follow-up.",
        { thread: rapidThread, is_mention: true },
      ),
    ],
    criteria:
      "In this rapid incident thread, the assistant posts exactly two replies in-order: first a rollback status update, second one concrete follow-up action (for example a next step or incident-summary action).",
  });

  slackEval("continuity: queued retry keeps same-thread follow-ups in order", {
    overrides: {
      retryable_timeout_calls: [1],
      retryable_max_attempts: 2,
      reply_texts: [
        "Rollback complete. Error rates are back to baseline.",
        "Next step: monitor dashboards for 30 minutes and post an incident summary.",
      ],
    },
    events: [
      mention(
        "We rolled back the deploy after a 500 spike. Give me a short status update.",
        { thread: rapidThread },
      ),
      threadMessage(
        "<@U_APP> Also give one concrete next step for incident follow-up.",
        { thread: rapidThread, is_mention: true },
      ),
    ],
    criteria:
      "Even when the first queued turn needs one retry, the assistant still posts exactly two non-error replies in-order in this incident thread: first a rollback status update, then one concrete follow-up action. It does not post a queue/deferred/internal-error failure message.",
  });
});
