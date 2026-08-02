import { assistantMessages, describeEval } from "vitest-evals";
import { expect } from "vitest";
import {
  mention,
  resourceEventNotification,
  rubric,
  slackEvals,
  steer,
  threadMessage,
  visibleAssistantText,
  visibleThreadReplies,
} from "../../src/helpers";

describeEval("Conversation Routing", slackEvals, (it) => {
  const steeringThread = {
    id: "thread-direct-mention-steering",
    channel_id: "CDIRECTMENTIONSTEERING",
    thread_ts: "17000000.1300",
  };

  it("when directly mentioned during a bot-notification run, prioritize the user's instruction", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [
        resourceEventNotification({
          eventKey: "linear-issue-linked",
          eventType: "issue.linked",
          intent: "Track linked infrastructure work in this Slack thread.",
          label: "Linear issue OPS-123",
          namespace: "linear",
          identifier: "OPS-123",
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
          "The user's direct instruction becomes the final focus of the response.",
        ],
        fail: [
          "Do not ignore or contradict the user's instruction in order to continue handling the Linear notification.",
          "Do not finish with a response that addresses only the Linear notification.",
        ],
      }),
    });

    const replies = visibleThreadReplies(result.session);
    expect(replies.length).toBeGreaterThan(0);
    expect(visibleAssistantText(result.session)).toMatch(/Alice/i);
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

    const replies = visibleThreadReplies(result.session);
    expect(replies).toHaveLength(1);
    expect(visibleAssistantText(result.session).length).toBeLessThanOrEqual(
      800,
    );
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
    expect(visibleThreadReplies(result.session).length).toBeGreaterThan(0);
  });
});
