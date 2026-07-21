import { describeEval } from "vitest-evals";
import { expect } from "vitest";
import {
  assistantTextContent,
  lastTurnReplies,
  mention,
  rubric,
  slackEvals,
  threadMessage,
} from "../../src/helpers";

describeEval("Actor Attribution", slackEvals, (it) => {
  const actorIdentityThread = {
    id: "thread-actor-identity",
    channel_id: "CACTORIDENTITY",
    thread_ts: "17000000.1301",
  };

  it("when another participant is already named, answer as the requested actor", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [
        mention("The billing rollout is paused until the retry queue drains.", {
          thread: actorIdentityThread,
          author: {
            user_id: "UALICE",
            user_name: "alice",
            full_name: "Alice Example",
          },
        }),
      ],
      events: [
        threadMessage(
          "Can you draft the one-sentence status update for this?",
          {
            thread: actorIdentityThread,
            is_mention: true,
            author: {
              user_id: "UDAVID",
              user_name: "dcramer",
              full_name: "David Cramer",
            },
          },
        ),
      ],
      criteria: rubric({
        pass: [
          "The second reply drafts a one-sentence status update about the paused billing rollout and retry queue.",
          "The second reply does not assign the drafting work to Alice, David, Junior, or another participant.",
        ],
        fail: [
          "Do not say Alice, David, Junior, or another participant will handle the draft.",
          "Do not answer only with a promise to draft it later.",
        ],
      }),
    });

    expect(lastTurnReplies(result.session).length).toBeGreaterThan(0);
  });

  const currentInstructionAuthorThread = {
    id: "thread-current-instruction-author",
    channel_id: "CCURRENTINSTRUCTIONAUTHOR",
    thread_ts: "17000000.1302",
  };

  it("when a different participant gives a first-person follow-up, treat it as their request", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [
        mention(
          "For the rollout summary, my preferred wording is formal and cautious.",
          {
            thread: currentInstructionAuthorThread,
            author: {
              user_id: "UALICE",
              user_name: "alice",
              full_name: "Alice Example",
            },
          },
        ),
      ],
      events: [
        threadMessage(
          "For the rollout summary, my preferred wording is casual and direct. What wording preference did I just give you?",
          {
            thread: currentInstructionAuthorThread,
            is_mention: true,
            author: {
              user_id: "URYAN",
              user_name: "ryan",
              full_name: "Ryan Example",
            },
          },
        ),
      ],
      criteria: rubric({
        pass: [
          "The second reply identifies the current actor as giving a casual/direct wording preference.",
          "The second reply does not attribute Alice's formal/cautious preference to the current actor.",
        ],
        fail: [
          "Do not answer the second turn as if Alice is the current actor.",
          "Do not say the current actor gave a formal or cautious preference.",
        ],
      }),
    });

    const replies = lastTurnReplies(result.session);
    expect(replies.length).toBeGreaterThan(0);
    const secondReply = assistantTextContent(
      replies.at(-1)?.content,
    ).toLowerCase();
    expect(secondReply).toMatch(/casual|direct/);
  });
});
