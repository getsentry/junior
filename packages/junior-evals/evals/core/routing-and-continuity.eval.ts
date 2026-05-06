import { describeEval } from "vitest-evals";
import { mention, rubric, slackEvals, threadMessage } from "../helpers";

describeEval("Routing and Continuity", slackEvals, (it) => {
  it("when a thread message explicitly mentions Junior, post a direct reply", async ({
    run,
  }) => {
    await run({
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
    });
  });

  it("when asked to post in channel, send a channel post instead of a thread reply", async ({
    run,
  }) => {
    await run({
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
    });
  });

  it("when asked to post in another named channel, explain the limitation instead", async ({
    run,
  }) => {
    await run({
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
    });
  });

  const actorIdentityThread = {
    id: "thread-actor-identity",
    channel_id: "C-actor-identity",
    thread_ts: "17000000.actor-identity",
  };

  it("when another participant is already named, answer as the requested actor", async ({
    run,
  }) => {
    await run({
      events: [
        mention("The billing rollout is paused until the retry queue drains.", {
          thread: actorIdentityThread,
          author: {
            user_id: "U_ALICE",
            user_name: "alice",
            full_name: "Alice Example",
          },
        }),
        threadMessage(
          "<@U_APP> can you draft the one-sentence status update for this?",
          {
            thread: actorIdentityThread,
            is_mention: true,
            author: {
              user_id: "U_DAVID",
              user_name: "dcramer",
              full_name: "David Cramer",
            },
          },
        ),
      ],
      criteria: rubric({
        contract:
          "When explicitly asked to do work in a multi-participant thread, the assistant treats itself as the requested actor.",
        pass: [
          "The assistant posts exactly two replies in order.",
          "The second reply drafts a one-sentence status update about the paused billing rollout and retry queue.",
          "The second reply does not assign the drafting work to Alice, David, Junior, or another participant.",
        ],
        fail: [
          "Do not say Alice, David, Junior, or another participant will handle the draft.",
          "Do not answer only with a promise to draft it later.",
        ],
      }),
    });
  });

  it("when the request is reaction-only, add a reaction without reply clutter", async ({
    run,
  }) => {
    await run({
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
    });
  });

  const continuityThread = {
    id: "thread-continuity",
    channel_id: "C-continuity",
    thread_ts: "17000000.continuity",
  };

  it("when a follow-up asks about the prior turn, recall the earlier budget context", async ({
    run,
  }) => {
    await run({
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
    });
  });
});
