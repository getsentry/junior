import { describe } from "vitest";
import { mention, rubric, slackEval, threadMessage } from "../helpers";

describe("Routing and Continuity", () => {
  slackEval(
    "when a thread message explicitly mentions Junior, post a direct reply",
    {
      events: [threadMessage("<@U_APP> what is 2+2?", { is_mention: true })],
      criteria: rubric({
        contract:
          "An explicit @mention in a thread always gets a direct reply.",
        pass: [
          "The assistant posts exactly one reply.",
          "The reply answers with 4.",
        ],
        fail: ["Do not return sandbox setup failure text."],
      }),
    },
  );

  slackEval(
    "when asked to post in channel, send a channel post instead of a thread reply",
    {
      events: [mention("@bot say hello to the channel!")],
      criteria: rubric({
        contract:
          "A user request to post in-channel is delivered as a channel post, not as a thread reply.",
        pass: [
          "channel_posts contains exactly one hello-style message with no thread_ts.",
          "assistant_posts does not contain that hello-style message as a thread reply.",
        ],
        allow: [
          "A lightweight acknowledgement reaction in reactions is acceptable.",
        ],
      }),
    },
  );

  slackEval(
    "when asked to post in another named channel, explain the limitation instead",
    {
      events: [
        mention(
          "@bot post this in #discuss-design-engineering instead: Heads up, design review starts in 10 minutes.",
        ),
      ],
      criteria: rubric({
        contract:
          "A request for another named channel does not get silently redirected to the current channel.",
        pass: [
          "channel_posts is empty.",
          "assistant_posts contains exactly one reply.",
          "That reply clearly says the assistant can only post to the current channel or cannot post to #discuss-design-engineering from here.",
        ],
        fail: [
          "Do not send a direct channel post to the current channel.",
          "Do not claim the message was posted to #discuss-design-engineering.",
        ],
      }),
    },
  );

  slackEval(
    "when the request is reaction-only, add a reaction without reply clutter",
    {
      events: [mention("react to this")],
      criteria: rubric({
        contract:
          "A reaction-only request is satisfied with reactions instead of reply clutter.",
        pass: ["reactions contains at least one added reaction."],
        fail: [
          "Do not add a redundant thread reply that echoes the emoji.",
          "Do not add a short acknowledgement reply such as 'Done'.",
        ],
      }),
    },
  );

  const continuityThread = {
    id: "thread-continuity",
    channel_id: "C-continuity",
    thread_ts: "17000000.continuity",
  };

  slackEval(
    "when a follow-up asks about the prior turn, recall the earlier budget context",
    {
      events: [
        mention("I need the budget by Friday.", { thread: continuityThread }),
        threadMessage("what did i just ask?", {
          thread: continuityThread,
          is_mention: true,
        }),
      ],
      criteria: rubric({
        contract:
          "A later question in the same thread can reference earlier context without restating it.",
        pass: [
          "The assistant posts exactly two replies in order.",
          "The second reply explicitly references the earlier budget context, including budget and/or Friday.",
        ],
        fail: ["Do not return sandbox setup failure text."],
      }),
    },
  );
});
