import { describeEval } from "vitest-evals";
import { mention, rubric, slackEvals, threadMessage } from "../helpers";

describeEval("Routing and Continuity", slackEvals, (it) => {
  it("when a thread message explicitly mentions Junior, post a direct reply", async ({
    run,
  }) => {
    await run({
      events: [threadMessage("<@U_APP> what is 2+2?", { is_mention: true })],
      criteria: rubric({
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
        pass: [
          "The normalized transcript contains exactly one hello-style channel_post assistant message with no thread_ts.",
          "The normalized transcript does not contain that hello-style message as a thread reply.",
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
        pass: [
          "The normalized transcript contains no channel_post assistant message.",
          "The normalized transcript contains exactly one assistant thread reply.",
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
    channel_id: "CACTORIDENTITY",
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
        pass: [
          "The normalized transcript contains at least one reaction_added assistant message.",
        ],
        fail: [
          "Do not add a redundant thread reply that echoes the emoji.",
          "Do not add a short acknowledgement reply such as 'Done'.",
        ],
      }),
    });
  });

  const continuityThread = {
    id: "thread-continuity",
    channel_id: "CCONTINUITY",
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
        pass: [
          "The assistant posts exactly two replies in order.",
          "The second reply explicitly references the earlier budget context, including budget and/or Friday.",
        ],
        fail: ["Do not return sandbox setup failure text."],
      }),
    });
  });
});
