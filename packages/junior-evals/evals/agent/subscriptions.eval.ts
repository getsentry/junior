import { describeEval, toolCalls } from "vitest-evals";
import { expect } from "vitest";
import {
  githubWebhook,
  mention,
  resourceEvent,
  rubric,
  slackEvals,
  visibleAssistantText,
  visibleThreadReplies,
} from "../../src/helpers";

describeEval("Resource Event Subscriptions", slackEvals, (it) => {
  it("looks up and subscribes to an exact deployment before GitHub creates it", async ({
    run,
  }) => {
    const commitSha = "c610b5d6a88c9da5d65627a1cdb3829b05c14f75";
    const result = await run({
      overrides: {
        credential_providers: ["github"],
        github_resource_events: true,
        plugin_packages: ["@sentry/junior-github"],
      },
      initialEvents: [
        mention(
          `Watch the Production deployment of getsentry/junior-prod for commit ${commitSha}. It may not exist yet; tell me when it succeeds, fails, or reports an error.`,
        ),
      ],
      criteria: rubric({
        pass: [
          "The reply confirms the exact deployment target will be monitored through event-based updates.",
          "The reply makes clear that the watch is temporary and says when it expires.",
        ],
        fail: [
          "Do not claim a polling task or recurring schedule was created.",
          "Do not ask the user to wait and check GitHub manually.",
        ],
      }),
    });

    expect(toolCalls(result.session)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "github_getDeployment",
          status: "ok",
          arguments: {
            commitSha,
            environment: "Production",
            repo: "getsentry/junior-prod",
          },
        }),
        expect.objectContaining({
          name: "watchResourceEvents",
          status: "ok",
          arguments: expect.objectContaining({
            events: expect.arrayContaining([
              "deployment.succeeded",
              "deployment.failed",
              "deployment.error",
            ]),
            namespace: "github",
            identifier: `deployment-source:getsentry/junior-prod:production:${commitSha}`,
            resourceType: "deployment_source",
          }),
        }),
      ]),
    );
    expect(toolCalls(result.session).map((call) => call.name)).not.toContain(
      "slackScheduleCreateTask",
    );
  });

  it("when a created PR can emit requested events, subscribe instead of polling", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        github_resource_events: true,
        plugin_dirs: ["fixtures/resource-event-plugins"],
        plugin_packages: ["@sentry/junior-github"],
      },
      initialEvents: [
        mention(
          "$eval-resource-events Create a pull request titled 'Prefer event subscriptions', then check it every five minutes and tell this thread if checks fail, review feedback arrives, it merges, or it closes.",
        ),
      ],
      criteria: rubric({
        pass: [
          "The reply confirms the pull request will be monitored through event-based updates for the requested outcomes.",
          "The reply makes clear that the watch is temporary and says when it expires.",
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
          status: "ok",
          arguments: expect.objectContaining({
            tool_name:
              "mcp__eval-resource-events__create-watchable-pull-request",
            arguments: expect.objectContaining({
              title: "Prefer event subscriptions",
            }),
          }),
        }),
        expect.objectContaining({
          name: "watchResourceEvents",
          status: "ok",
          arguments: expect.objectContaining({
            namespace: "github",
            identifier: "getsentry/junior#208",
            resourceType: "pull_request",
            events: expect.arrayContaining([
              "pull_request.checks.failed",
              "pull_request.review.changes_requested",
              "pull_request.review.commented",
              "pull_request.review_comment.created",
              "pull_request.merged",
              "pull_request.closed_unmerged",
            ]),
          }),
          result: expect.objectContaining({
            stop_watching: {
              execution_tool: "executeTool",
              execution_example: {
                tool_name: "stopWatchingResources",
                arguments: { id: expect.stringMatching(/^resub_/) },
              },
            },
          }),
        }),
      ]),
    );
    expect(toolCalls(result.session).map((call) => call.name)).not.toContain(
      "slackScheduleCreateTask",
    );
  });

  it("when a subscribed event does not serve the intent, stay silent", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [
        githubWebhook({
          eventName: "check_suite",
          subscription: {
            events: ["pull_request.checks.recovered"],
            intent:
              "Let the original Slack thread know when Junior's pull request lands.",
            label: "GitHub PR getsentry/junior#702",
            identifier: "getsentry/junior#702",
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
    });
    expect(visibleThreadReplies(result.session)).toHaveLength(0);
  });

  it("when a subscribed PR check fails, summarize the failure and suggest next steps", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [
        resourceEvent({
          eventKey: "github-delivery-checks-failed",
          eventType: "pull_request.checks.failed",
          intent:
            "Watch the pull request Junior opened for CI failures before review.",
          label: "GitHub PR getsentry/junior#691",
          identifier: "getsentry/junior#691",
          resourceType: "pull_request",
          trustedSummary:
            "GitHub PR getsentry/junior#691 checks failed (1) for abcdef123456.",
          data: {
            repo: "getsentry/junior",
            pullRequest: 691,
            headSha: "abcdef1234567890abcdef1234567890abcdef12",
            scope: "check_suite",
            suiteConclusion: "failure",
            checkSuiteId: 42,
            checkSuiteUrl:
              "https://github.com/getsentry/junior/commit/abcdef1234567890abcdef1234567890abcdef12/checks?check_suite_id=42",
            failingChecks: [
              {
                checkRunId: 1,
                conclusion: "failure",
                htmlUrl: "https://github.com/getsentry/junior/actions/runs/1",
              },
            ],
          },
          untrustedText:
            "Failed checks:\n- test: https://github.com/getsentry/junior/actions/runs/1",
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

    expect(toolCalls(result.session)).toHaveLength(0);
    expect(visibleThreadReplies(result.session)).toHaveLength(1);
    expect(visibleAssistantText(result.session).length).toBeLessThanOrEqual(
      800,
    );
  });

  it("when a subscribed PR is merged, report completion without extra work", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [
        resourceEvent({
          eventKey: "github-delivery-pr-merged",
          eventType: "pull_request.merged",
          intent:
            "Let the original Slack thread know when Junior's pull request lands.",
          label: "GitHub PR getsentry/junior#702",
          identifier: "getsentry/junior#702",
          resourceType: "pull_request",
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
  });
});
