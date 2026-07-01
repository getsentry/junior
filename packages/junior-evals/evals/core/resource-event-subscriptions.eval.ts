import { describeEval } from "vitest-evals";
import {
  resourceEventNotification,
  rubric,
  slackEvals,
} from "../../src/helpers";

describeEval("Resource Event Subscriptions", slackEvals, (it) => {
  it("when a subscribed PR check fails, summarize the failure and suggest next steps", async ({
    run,
  }) => {
    await run({
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
  });

  it("when a subscribed PR is merged, report completion without extra work", async ({
    run,
  }) => {
    await run({
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
  });
});
