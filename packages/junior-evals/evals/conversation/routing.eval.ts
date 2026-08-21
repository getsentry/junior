import { describeEval } from "vitest-evals";
import { expect } from "vitest";
import {
  mention,
  resourceEventNotification,
  rubric,
  slackEvals,
  steer,
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
          resourceType: "issue",
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
});
