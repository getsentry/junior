import { assistantMessages, describeEval, toolCalls } from "vitest-evals";
import { expect } from "vitest";
import { NO_REPLY_MARKER } from "@/chat/no-reply";
import {
  mention,
  resourceEventNotification,
  rubric,
  slackEvals,
  steer,
  threadMessage,
} from "../../src/helpers";

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
  const steeringThread = {
    id: "thread-direct-mention-steering",
    channel_id: "CDIRECTMENTIONSTEERING",
    thread_ts: "17000000.1300",
  };

  it("when directly mentioned during a bot-notification run, answer the user's instruction only", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [
        resourceEventNotification({
          eventKey: "linear-issue-linked",
          eventType: "issue.linked",
          intent: "Track linked infrastructure work in this Slack thread.",
          label: "Linear issue OPS-123",
          provider: "linear",
          resourceRef: "linear:issue:OPS-123",
          thread: steeringThread,
          trustedSummary: "Linear issue OPS-123 was linked to this thread.",
        }),
      ],
      events: [
        steer(
          mention(
            "@junior The deployment owner is Alice. Tell the thread who owns the deployment.",
            { thread: steeringThread },
          ),
        ),
      ],
      criteria: rubric({
        pass: [
          "The reply says Alice owns the deployment.",
          "The Linear notification is treated only as context for the user's direct instruction.",
        ],
        fail: [
          "Do not post a standalone response to the Linear notification.",
          "Do not say there is nothing to act on before answering the user.",
        ],
      }),
    });

    const replies = visibleThreadReplies(result.session);
    expect(replies).toHaveLength(1);
    expect(textContent(replies[0]?.content)).toMatch(/Alice/i);
  });

  it("when a thread message explicitly mentions Junior, post a direct reply", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [threadMessage("What is 2+2?", { is_mention: true })],
      criteria: rubric({
        pass: ["The reply answers with 4."],
        fail: ["Do not return sandbox setup failure text."],
      }),
    });

    expect(visibleThreadReplies(result.session)).toHaveLength(1);
  });

  it("when asked to post in another named channel, explain the limitation instead", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [
        mention(
          "@bot post this in #discuss-design-engineering instead: Heads up, design review starts in 10 minutes.",
        ),
      ],
      criteria: rubric({
        pass: [
          "The reply clearly says the assistant can only post to the current channel or cannot post to #discuss-design-engineering from here.",
        ],
        fail: [
          "Do not send a direct channel post to the current channel.",
          "Do not claim the message was posted to #discuss-design-engineering.",
        ],
      }),
    });

    expect(
      assistantMessages(result.session).filter(
        (message) => message.metadata?.event_type === "channel_post",
      ),
    ).toHaveLength(0);
    expect(visibleThreadReplies(result.session)).toHaveLength(1);
  });

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

    expect(visibleThreadReplies(result.session)).toHaveLength(2);
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

    const replies = visibleThreadReplies(result.session);
    expect(replies).toHaveLength(2);
    const secondReply = textContent(replies[1]?.content).toLowerCase();
    expect(secondReply).toMatch(/casual|direct/);
  });

  it("when the request is reaction-only, add a reaction without reply clutter", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [mention("react to this")],
      criteria: rubric({
        pass: [
          "The assistant does not add visible thread-reply clutter for this reaction-only request.",
        ],
        fail: [
          "Do not rely only on a runtime processing reaction.",
          "Do not add a redundant thread reply that echoes the emoji.",
          "Do not add a short acknowledgement reply such as 'Done'.",
        ],
      }),
    });
    expect(toolCalls(result.session)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "addReaction" }),
      ]),
    );
    expect(
      assistantMessages(result.session).filter(
        (message) => message.metadata?.event_type === "reaction_added",
      ).length,
    ).toBeGreaterThan(0);
    expect(visibleThreadReplies(result.session)).toEqual([]);
    expect(visibleText(result.session)).not.toContain(NO_REPLY_MARKER);
  });

  const continuityThread = {
    id: "thread-continuity",
    channel_id: "CCONTINUITY",
    thread_ts: "17000000.1303",
  };

  it("when a follow-up asks about the prior turn, recall the earlier budget context", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [
        mention("I need the budget by Friday.", { thread: continuityThread }),
      ],
      events: [
        threadMessage("what did i just ask?", {
          thread: continuityThread,
          is_mention: true,
        }),
      ],
      criteria: rubric({
        pass: [
          "The second reply explicitly references the earlier budget context, including budget and/or Friday.",
        ],
        fail: ["Do not return sandbox setup failure text."],
      }),
    });

    expect(visibleThreadReplies(result.session)).toHaveLength(2);
  });
});
