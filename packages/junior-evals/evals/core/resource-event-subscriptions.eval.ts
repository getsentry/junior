import { assistantMessages, describeEval, toolCalls } from "vitest-evals";
import { expect } from "vitest";
import {
  conversationMessages,
  githubWebhook,
  mention,
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
  it("when a created PR can emit requested events, subscribe instead of polling", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        plugin_dirs: ["fixtures/resource-event-plugins"],
      },
      initialEvents: [
        mention(
          "/eval-resource-events Use the provider to create a pull request titled 'Prefer event subscriptions', then check it every five minutes and tell this thread if checks fail, review feedback arrives, it merges, or it closes.",
        ),
      ],
      criteria: rubric({
        pass: [
          "The reply confirms the pull request will be monitored through event-based updates for the requested outcomes.",
        ],
        fail: [
          "Do not ask the user to monitor GitHub manually.",
          "Do not claim a recurring five-minute polling task or schedule was created.",
        ],
      }),
    });

    expect(toolCalls(result.session)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "callMcpTool",
          arguments: expect.objectContaining({
            tool_name:
              "mcp__eval-resource-events__create-watchable-pull-request",
            arguments: expect.objectContaining({
              title: "Prefer event subscriptions",
            }),
          }),
        }),
        expect.objectContaining({
          name: "subscribeToResourceEvents",
          arguments: expect.objectContaining({
            provider: "github",
            resourceRef: "github:pull_request:getsentry/junior#208",
            resourceType: "pull_request",
            events: expect.arrayContaining([
              "checks.failed",
              "review.changes_requested",
              "review.commented",
              "review_comment.created",
              "state.merged",
              "state.closed_unmerged",
            ]),
          }),
        }),
      ]),
    );
    expect(toolCalls(result.session).map((call) => call.name)).not.toContain(
      "scheduler_slackScheduleCreateTask",
    );
  });

  it("when a subscribed PR check fails, summarize the failure and suggest next steps", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [
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

  it("when a subscribed event does not serve the intent, stay silent", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [
        githubWebhook({
          eventName: "check_suite",
          subscription: {
            events: ["checks.recovered"],
            intent:
              "Let the original Slack thread know when Junior's pull request lands.",
            label: "GitHub PR getsentry/junior#702",
            resourceRef: "github:pull_request:getsentry/junior#702",
            resourceType: "pull_request",
          },
          body: {
            action: "completed",
            repository: { full_name: "getsentry/junior" },
            check_suite: {
              conclusion: "success",
              head_sha: "abcdef1234567890",
              pull_requests: [{ number: 702 }],
            },
          },
        }),
      ],
      criteria: rubric({
        pass: [
          "The assistant does not post any visible thread reply.",
          "The assistant treats recovered checks as outside the subscription intent, which only asks for the merge outcome.",
        ],
        fail: [
          "Do not narrate or explain the recovered CI status.",
          "Do not post a visible message for an event that does not serve the subscription intent.",
        ],
      }),
    });
    const messages = await conversationMessages(result.session);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          text: expect.stringContaining(
            "GitHub PR getsentry/junior#702 checks recovered",
          ),
        }),
      ]),
    );
    expect(visibleThreadReplies(result.session)).toHaveLength(0);
  });

  it("when a subscribed PR is merged, report completion without extra work", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [
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
