import { assistantMessages, describeEval, toolCalls } from "vitest-evals";
import { expect } from "vitest";
import { NO_REPLY_MARKER } from "@/chat/no-reply";
import { mention, rubric, slackEvals, threadMessage } from "../../src/helpers";

type EvalSession = Parameters<typeof assistantMessages>[0];

function textContent(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function visibleThreadReplies(session: EvalSession) {
  return assistantMessages(session).filter(
    (message) =>
      message.metadata?.event_type === "thread_post" &&
      textContent(message.content).trim().length > 0,
  );
}

function visibleText(session: EvalSession): string {
  return assistantMessages(session)
    .map((message) => textContent(message.content))
    .join("\n");
}

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
    const result = await run({
      events: [mention("react to this")],
      criteria: rubric({
        pass: [
          "The normalized transcript contains at least one reaction_added assistant message.",
          "The assistant tool calls include addReaction for the requested reaction.",
          `The visible transcript contains no thread reply; the no-reply marker ${NO_REPLY_MARKER} is only an internal publication signal.`,
        ],
        fail: [
          "Do not rely only on a runtime processing reaction.",
          "Do not add a redundant thread reply that echoes the emoji.",
          "Do not add a short acknowledgement reply such as 'Done'.",
          `Do not leak the literal marker ${NO_REPLY_MARKER} as visible text.`,
        ],
      }),
    });
    expect(toolCalls(result.session)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "addReaction" }),
      ]),
    );
    expect(visibleThreadReplies(result.session)).toEqual([]);
    expect(visibleText(result.session)).not.toContain(NO_REPLY_MARKER);
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
