import { describe } from "vitest";
import {
  editedMessage,
  mention,
  plainMessage,
  slackEval,
  threadMessage,
} from "../helpers";

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

  const editedMentionThread = {
    id: "thread-edited-mention",
    channel_id: "C-edited-mention",
    thread_ts: "17000000.edited",
  };

  slackEval("routing: edited message that adds a mention gets a reply", {
    events: [
      plainMessage("can you take a look at this deploy?", {
        thread: editedMentionThread,
        messageId: "m-edited-mention",
      }),
      editedMessage("<@U_APP> can you take a look at this deploy?", {
        thread: editedMentionThread,
        messageId: "m-edited-mention",
        is_mention: true,
      }),
    ],
    criteria:
      "The assistant does not reply before the mention is added. After the edited message adds the mention, it posts exactly one reply that addresses the deploy/help request and does not include sandbox setup failure text.",
  });
});
