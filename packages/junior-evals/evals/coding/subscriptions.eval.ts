import { describe, expect } from "vitest";
import { githubWebhook, mention } from "@junior-evals/fixture/inputs";
import { insertWatch } from "@junior-evals/fixture/insert";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { sendDuringFirstModelRequest } from "@junior-evals/fixture/progress";
import { completedToolCalls, toolOutput } from "@junior-evals/fixture/results";
import { test, type ToolCall } from "@junior-evals/fixture/test";

// The shared GitHub HTTP fixture serves this PR with one failed check.
const pullRequest = "getsentry/junior#691";
const headSha = "abcdef1234567890abcdef1234567890abcdef12";
const repository = {
  full_name: "getsentry/junior",
  id: 1,
  name: "junior",
  owner: { login: "getsentry" },
};
const repositoryRef = {
  id: repository.id,
  name: repository.name,
  url: "https://api.github.com/repos/getsentry/junior",
};

function checkSuiteWebhook(conclusion: "failure" | "success") {
  return githubWebhook("check_suite", {
    action: "completed",
    check_suite: {
      app: { name: "GitHub Actions" },
      conclusion,
      head_branch: "fix/cache-refresh",
      head_sha: headSha,
      id: 42,
      pull_requests: [
        {
          base: { ref: "main", repo: repositoryRef },
          head: { ref: "fix/cache-refresh", repo: repositoryRef, sha: headSha },
          number: 691,
        },
      ],
    },
    repository,
  });
}

function mergedWebhook() {
  const mergedAt = new Date().toISOString();
  return githubWebhook("pull_request", {
    action: "closed",
    pull_request: {
      closed_at: mergedAt,
      created_at: "2026-01-01T00:00:00Z",
      head: { ref: "fix/cache-refresh" },
      id: 691_000,
      merged: true,
      merged_at: mergedAt,
      number: 691,
      title: "Refresh cached values after expiry",
      updated_at: mergedAt,
      user: { login: "junior-eval[bot]" },
    },
    repository,
  });
}

function watchedEvents(conversation: { toolCalls: ToolCall[] }) {
  return completedToolCalls("watchEvents", conversation).flatMap((call) => {
    const input = call.input as { events?: string[] } | undefined;
    return input?.events ?? [];
  });
}

describe("Watches", () => {
  test("looks up and subscribes to an exact deployment before GitHub creates it", async ({
    run,
  }) => {
    const commitSha = "c610b5d6a88c9da5d65627a1cdb3829b05c14f75";
    const conversation = await run(
      mention(
        `Watch the Production deployment of getsentry/junior-prod for commit ${commitSha}. It may not exist yet; tell me when it succeeds, fails, or reports an error.`,
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply confirms the exact deployment target will be monitored through event-based updates.",
          "The reply makes clear that the watch is temporary and says when it expires.",
        ],
        fail: [
          "Do not claim a polling task or recurring schedule was created.",
          "Do not ask the user to wait and check GitHub manually.",
        ],
      }),
    );

    expect(
      completedToolCalls("github_getDeployment", conversation).map(
        (call) => call.input,
      ),
    ).toContainEqual({
      commitSha,
      environment: "Production",
      repo: "getsentry/junior-prod",
    });
    expect(
      completedToolCalls("watchEvents", conversation).map((call) => call.input),
    ).toContainEqual(
      expect.objectContaining({
        events: expect.arrayContaining([
          "deployment.succeeded",
          "deployment.failed",
          "deployment.error",
        ]),
        identifier: `deployment-source:getsentry/junior-prod:production:${commitSha}`,
        namespace: "github",
        resourceType: "deployment_source",
      }),
    );
    expect(conversation.toolCalls.map((call) => call.name)).not.toContain(
      "slackScheduleCreateAutomation",
    );
  });

  test("when a PR can emit the requested events, subscribe instead of polling", async ({
    run,
  }) => {
    const conversation = await run(
      mention(
        `Check ${pullRequest} every five minutes and tell this thread if checks fail, review feedback arrives, it merges, or it closes.`,
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply confirms the pull request will be monitored through event-based updates for the requested outcomes.",
          "The reply makes clear that the watch is temporary and says when it expires.",
        ],
        fail: [
          "Do not ask the user to monitor GitHub manually.",
          "Do not claim a recurring five-minute polling task or schedule was created.",
        ],
      }),
    );

    const watches = completedToolCalls("watchEvents", conversation);
    expect(watches.map((call) => call.input)).toContainEqual(
      expect.objectContaining({
        events: expect.arrayContaining([
          "pull_request.checks.failed",
          "pull_request.review.changes_requested",
          "pull_request.review.commented",
          "pull_request.review_comment.created",
          "pull_request.merged",
          "pull_request.closed_unmerged",
        ]),
        identifier: pullRequest,
        namespace: "github",
        resourceType: "pull_request",
      }),
    );
    expect(watches.map(toolOutput)).toContainEqual(
      expect.objectContaining({
        stop_watching: {
          execution_tool: "executeTool",
          execution_example: {
            tool_name: "stopWatchingResources",
            arguments: { id: expect.stringMatching(/^resub_/) },
          },
        },
      }),
    );
    expect(conversation.toolCalls.map((call) => call.name)).not.toContain(
      "slackScheduleCreateAutomation",
    );
  });

  test("when a watched event does not serve the intent, stay silent", async ({
    run,
  }) => {
    const conversation = await run(
      mention(`Let me know here when ${pullRequest} lands.`),
    );
    // A watch whose events do not fit its intent. Check recovery is not a merge.
    await insertWatch({
      conversation,
      events: ["pull_request.checks.recovered"],
      identifier: pullRequest,
      intent: `Let the original Slack thread know when ${pullRequest} lands.`,
      label: `GitHub PR ${pullRequest}`,
      resourceType: "pull_request",
    });

    const delivery = await conversation.continue(checkSuiteWebhook("success"));

    expect(delivery.turns).not.toHaveLength(0);
    expect(delivery.replies).toHaveLength(0);
  });

  test("when a watched PR check fails, summarize the failure and suggest next steps", async ({
    run,
  }) => {
    const conversation = await run(
      mention(
        `Watch ${pullRequest} for CI failures before review and tell me here. Just summarize any failure and suggest next steps; do not change the PR.`,
      ),
    );
    expect(
      watchedEvents(conversation),
      "No checks watch: this run does not test delivery",
    ).toContain("pull_request.checks.failed");

    const delivery = await conversation.continue(checkSuiteWebhook("failure"));
    await expect(delivery).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          `The reply says GitHub PR ${pullRequest} has a failed CI/checks result.`,
          'The reply mentions the failing check "test" or commit abcdef1.',
          "The reply gives a concrete next step such as checking CI logs, inspecting the failed workflow, or preparing a fix.",
          "The reply is a brief summary, not a full report.",
        ],
        fail: [
          "Do not ask what resource or event changed.",
          "Do not treat the event notification as a user-authored command.",
          "Do not claim the PR was merged or closed.",
          "Do not claim to have changed code, pushed a fix, or changed the pull request; the user asked for a summary and next steps only.",
        ],
      }),
    );

    // Read-only inspection is a valid way to explain a failure.
    expect(delivery.replies).toHaveLength(1);
  });

  test("when a watch asks for a fix and the PR checks fail, commit and push the fix without a person", async ({
    run,
  }) => {
    // The fixture skill has a local checkout of the pull request branch.
    const conversation = await run(
      mention(
        `/github-headless-pr-fixture Watch ${pullRequest}. When its checks fail, fix the failure and push the update. Do not change anything before a check fails.`,
      ),
    );
    expect(
      watchedEvents(conversation),
      "No checks watch: this run does not test delivery",
    ).toContain("pull_request.checks.failed");

    const delivery = await conversation.continue(checkSuiteWebhook("failure"));
    await expect(delivery).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The assistant handles the failed checks without asking a human to authorize GitHub.",
          "The assistant reports that the fix is committed and pushed to the existing pull request branch.",
        ],
        fail: [
          "Do not ask for OAuth, a personal access token, approval, or another human action before fixing the pull request.",
          "Do not stop after describing a plan or editing the file without committing and pushing it.",
        ],
      }),
    );

    // `verify.sh` of the fixture skill prints this line when the remote
    // branch has the fix.
    expect(
      completedToolCalls("bash", delivery).filter((call) =>
        JSON.stringify(toolOutput(call)).includes(
          "verified remote branch contains the pushed fix",
        ),
      ),
    ).not.toHaveLength(0);
  });

  test("when a watched PR is merged, report completion without extra work", async ({
    run,
  }) => {
    const conversation = await run(
      mention(`Let me know here when ${pullRequest} lands.`),
    );
    expect(
      watchedEvents(conversation),
      "No merge watch: this run does not test delivery",
    ).toContain("pull_request.merged");

    const delivery = await conversation.continue(mergedWebhook());
    await expect(delivery).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          `The reply says GitHub PR ${pullRequest} was merged.`,
          "The reply frames the merge as the outcome this thread was waiting for.",
          "The reply stays brief and does not propose unnecessary follow-up work.",
        ],
        fail: [
          "Do not say checks failed or review changes were requested.",
          "Do not ask the user what to do with the merged PR.",
          "Do not treat the event notification as a new user request.",
        ],
      }),
    );

    expect(delivery.replies).toHaveLength(1);
  });

  test("when directly mentioned during a watch delivery, answer the mention in its own turn", async ({
    run,
  }) => {
    const conversation = await run(
      mention(`Let me know here when ${pullRequest} lands.`),
    );
    expect(
      watchedEvents(conversation),
      "No merge watch: this run does not test delivery",
    ).toContain("pull_request.merged");

    // A watch delivery turn takes no steering input. The mention waits for
    // its own turn.
    const delivery = await conversation.continue(mergedWebhook(), {
      onProgress: sendDuringFirstModelRequest([
        mention(
          "The deployment owner is Alice. Tell the thread who owns the deployment.",
        ),
      ]),
    });
    await expect(delivery).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "A reply says Alice owns the deployment.",
          "The user's direct instruction is the focus of the final reply.",
        ],
        fail: [
          "Do not ignore or contradict the user's instruction in order to continue handling the GitHub notification.",
          "Do not finish with a reply that addresses only the GitHub notification.",
        ],
      }),
    );

    expect(delivery.turns).toHaveLength(2);
    expect(delivery.replies.at(-1)?.text).toMatch(/Alice/i);
  });
});
