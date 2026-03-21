import { describe } from "vitest";
import { mention, slackEval, threadMessage } from "../helpers";

describe("Conversational Evals: Routing and Continuity", () => {
  slackEval("routing: subscribed skip", {
    behavior: {
      subscribed_decisions: [
        { should_reply: false, reason: "side conversation" },
      ],
    },
    events: [threadMessage("thanks everyone")],
    criteria:
      "The assistant posts no reply when subscription logic decides to skip this message.",
  });

  slackEval("routing: acknowledgment-only subscribed message is skipped", {
    events: [threadMessage("thanks!")],
    criteria:
      "The assistant posts no reply for acknowledgment-only subscribed thread messages that are not explicit mentions.",
  });

  slackEval("routing: explicit mention forces reply", {
    events: [threadMessage("<@U_APP> what is 2+2?", { is_mention: true })],
    criteria:
      "The assistant posts exactly one reply, answers with 4, and does not respond with sandbox setup failure text.",
  });

  const optOutThread = {
    id: "thread-opt-out",
    channel_id: "C-opt-out",
    thread_ts: "17000000.optout",
  };

  slackEval("routing: explicit stop request opts out until re-mentioned", {
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

  slackEval("routing: explicit in-channel post request uses channel post", {
    behavior: { mock_slack_api: true },
    events: [mention("@bot say hello to the channel!")],
    criteria:
      "The assistant sends the hello message as a channel post (channel_posts has exactly one item with hello/wave-style text and no thread_ts). It does not post hello/wave text as a thread reply in assistant_posts. An optional lightweight acknowledgement reaction in reactions is acceptable.",
  });

  slackEval(
    "routing: explicit reaction request reacts without redundant reply",
    {
      behavior: { mock_slack_api: true },
      events: [mention("@bot react to this with a thumbs up only")],
      criteria:
        "The assistant adds exactly one thumbs-up-style reaction in reactions and does not send a redundant thread reply in assistant_posts.",
    },
  );

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

  slackEval("routing: follow-up question without mention still replies", {
    behavior: { reply_texts: ["You need the budget by Friday."] },
    events: [
      mention("I need the budget by Friday.", { thread: continuityThread }),
      threadMessage("what did you just say about the budget?", {
        thread: continuityThread,
      }),
    ],
    criteria:
      "The assistant posts two replies in-order. The second reply plainly restates that the budget is needed by Friday using prior thread context, and does not just repeat unresolved clarifying questions.",
  });

  const rapidThread = {
    id: "thread-rapid",
    channel_id: "C-rapid",
    thread_ts: "17000000.rapid",
  };

  slackEval("continuity: rapid same-thread messages keep order", {
    behavior: {
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
});
