import { describeEval, toolCalls } from "vitest-evals";
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

  const ambientTicketOfferThread = {
    id: "thread-ambient-ticket-offer",
    channel_id: "CAMBIENTTICKET",
    thread_ts: "17000000.1304",
  };

  it("when ambient chat offers a ticket and the actor asks only for a lookup, do not create tickets", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [
        threadMessage(
          "Would it help if I drafted a tracker ticket for this customer case?",
          {
            thread: ambientTicketOfferThread,
            author: {
              user_id: "ULAMBERTO",
              user_name: "lamberto",
              full_name: "Lamberto Example",
            },
          },
        ),
      ],
      events: [
        threadMessage(
          [
            "I assume we might already have one. Feel free to handle the customer case.",
            "",
            "@junior do we already have Linear or GitHub tickets about create-issue modal slowness from product issues or user feedback, and are they the same root cause?",
          ].join("\n"),
          {
            thread: ambientTicketOfferThread,
            is_mention: true,
            author: {
              user_id: "UBRUNO",
              user_name: "bruno",
              full_name: "Bruno Example",
            },
          },
        ),
      ],
      criteria: rubric({
        pass: [
          "Junior answers the lookup about whether tickets already exist and whether root causes match.",
          "Junior does not create, update, or comment on a Linear or GitHub ticket in this turn.",
        ],
        fail: [
          "Do not treat the earlier unaddressed ticket-offer message as authorization to file or update a ticket.",
          "Do not create a new tracker issue, post an issue comment, or claim a ticket was filed.",
          "Do not only promise to file a ticket later without answering the lookup.",
        ],
      }),
    });

    expect(lastTurnReplies(result.session).length).toBeGreaterThan(0);
    const callNames = toolCalls(result.session).map((call) => call.name);
    expect(callNames).not.toContain("github_createIssue");
    expect(callNames).not.toContain("github_updateIssue");
    expect(callNames).not.toContain("callMcpTool");
    expect(
      toolCalls(result.session).some(
        (call) =>
          call.name === "bash" &&
          typeof call.arguments?.command === "string" &&
          /issues\/.*\/comments|--method\s+POST|gh\s+issue\s+create/i.test(
            call.arguments.command,
          ),
      ),
    ).toBe(false);
  });
});
