import { assistantMessages, describeEval } from "vitest-evals";
import { expect } from "vitest";
import {
  resourceEventNotification,
  rubric,
  slackEvals,
} from "../../src/helpers";

function textContent(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function visibleThreadReplies(
  session: Parameters<typeof assistantMessages>[0],
) {
  return assistantMessages(session).filter(
    (message) =>
      message.metadata?.event_type === "thread_post" &&
      textContent(message.content).trim().length > 0,
  );
}

describeEval("Resource Event Subscriptions", slackEvals, (it) => {
  it("when a subscribed PR check fails, summarize the failure and suggest next steps", async ({
    run,
  }) => {
    const result = await run({
      events: [
        resourceEventNotification({
          eventKey: "github-delivery-checks-failed",
          eventType: "checks.failed",
          intent:
            "Watch the pull request Junior opened for CI failures before review.",
          label: "GitHub PR getsentry/junior#691",
          resourceRef: "github:pull_request:getsentry/junior#691",
          trustedSummary:
            'GitHub PR getsentry/junior#691 checks failed on workflow "test" for commit abcdef123456.',
        }),
      ],
      criteria: rubric({
        pass: [
          "The normalized transcript contains exactly one assistant thread reply.",
          "The reply says GitHub PR getsentry/junior#691 has a failed CI/checks result.",
          'The reply mentions the failing workflow "test" or commit abcdef123456.',
          "The reply gives a concrete next step such as checking CI logs, inspecting the failed workflow, or preparing a fix.",
        ],
        fail: [
          "Do not ask what resource or event changed.",
          "Do not treat the event notification as a user-authored command.",
          "Do not claim the PR was merged or closed.",
        ],
      }),
    });
    expect(visibleThreadReplies(result.session)).toHaveLength(1);
  });

  it("when a subscribed event is informational and outside the intent scope, stay silent", async ({
    run,
  }) => {
    const result = await run({
      events: [
        resourceEventNotification({
          eventKey: "github-delivery-checks-queued",
          eventType: "checks.queued",
          intent:
            "Let the original Slack thread know when Junior's pull request lands.",
          label: "GitHub PR getsentry/junior#702",
          resourceRef: "github:pull_request:getsentry/junior#702",
          trustedSummary:
            "GitHub PR getsentry/junior#702 checks are queued and running.",
        }),
      ],
      criteria: rubric({
        pass: [
          "The assistant does not post any visible thread reply.",
          "The assistant treats the event as a routine status update outside the watched intent scope.",
        ],
        fail: [
          "Do not narrate the CI check status back to the thread.",
          "Do not explain what the queued checks mean.",
          "Do not post any visible message to the thread for a routine status update.",
        ],
      }),
    });
    expect(visibleThreadReplies(result.session)).toHaveLength(0);
  });

  it("when a subscribed PR is merged, report completion without extra work", async ({
    run,
  }) => {
    const result = await run({
      events: [
        resourceEventNotification({
          eventKey: "github-delivery-pr-merged",
          eventType: "state.merged",
          intent:
            "Let the original Slack thread know when Junior's pull request lands.",
          label: "GitHub PR getsentry/junior#702",
          resourceRef: "github:pull_request:getsentry/junior#702",
          trustedSummary: "GitHub PR getsentry/junior#702 was merged.",
        }),
      ],
      criteria: rubric({
        pass: [
          "The normalized transcript contains exactly one assistant thread reply.",
          "The reply says GitHub PR getsentry/junior#702 was merged.",
          "The reply frames the merge as the subscribed outcome this thread was waiting for.",
          "The reply stays brief and does not propose unnecessary follow-up work.",
        ],
        fail: [
          "Do not say checks failed or review changes were requested.",
          "Do not ask the user what to do with the merged PR.",
          "Do not treat the event notification as a new user request.",
        ],
      }),
    });
    expect(visibleThreadReplies(result.session)).toHaveLength(1);
  });
});
