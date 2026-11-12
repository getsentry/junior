import { describe, expect } from "vitest";
import {
  githubWebhook,
  heartbeat,
  slackMention,
} from "@junior-evals/fixture/inputs";
import {
  insertGitHubDraftWatch,
  insertLinkedGitHubIdentity,
  insertScheduledAutomation,
  insertWatch,
  slackChannel,
} from "@junior-evals/fixture/insert";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { sendDuringFirstModelRequest } from "@junior-evals/fixture/progress";
import { completedToolCalls, toolOutput } from "@junior-evals/fixture/results";
import { test, type RunAgent, type ToolCall } from "@junior-evals/fixture/test";

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

/**
 * Start a child Thread that maintains the PR, and add the Watch that Junior
 * adds after it opens a pull request. The Thread then gets the PR events.
 */
async function startPullRequestThread(run: RunAgent, events: string[]) {
  const conversation = await run(
    slackMention(
      `Use spawnAgent to start one Thread (kind "thread") named "pr-thread" with the task "Maintain ${pullRequest}. Reply READY now. A watch on the PR sends you its events later."`,
    ),
  );
  const [spawned] = completedToolCalls("spawnAgent", conversation).map(
    (call) => toolOutput(call) as { conversation_id?: string },
  );
  expect(
    spawned?.conversation_id,
    "No child Thread: this run does not test its PR events",
  ).toEqual(expect.any(String));
  await insertWatch({
    conversation: { conversationId: spawned!.conversation_id! },
    events,
    identifier: pullRequest,
    intent:
      "Maintain pull requests Junior creates. For actionable review feedback or failed checks, inspect the evidence, make scoped fixes, verify them, and push. When a reviewer submits a review, notify the person who asked for the pull request by @-mentioning their Slack user ID, with the reviewer, the review outcome, and the pull request link. Otherwise stay silent.",
    label: `GitHub PR ${pullRequest}`,
    resourceType: "pull_request",
  });
  return await conversation.child(spawned!.conversation_id!);
}

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

// The shared GitHub HTTP fixture serves these drafts: #692 with every
// required check passing, #693 with an open decision in its body, and #694
// with another required check failing.
const draftHeadShas = {
  692: "6920000000000000000000000000000000000692",
  693: "6930000000000000000000000000000000000693",
  694: "6940000000000000000000000000000000000694",
};
type DraftNumber = keyof typeof draftHeadShas;

/** A passing check suite on one of the drafts. */
function draftChecksPassedWebhook(number: DraftNumber) {
  const sha = draftHeadShas[number];
  const ref = `feat/cache-warmup-${number}`;
  return githubWebhook("check_suite", {
    action: "completed",
    check_suite: {
      app: { name: "GitHub Actions" },
      conclusion: "success",
      head_branch: ref,
      head_sha: sha,
      id: number,
      pull_requests: [
        {
          base: { ref: "main", repo: repositoryRef },
          head: { ref, repo: repositoryRef, sha },
          number,
        },
      ],
    },
    repository,
  });
}

/** Add the Watch that Junior adds after it opens a draft to a thread. */
async function startDraftThread(run: RunAgent, number: DraftNumber) {
  const draft = `getsentry/junior#${number}`;
  const conversation = await run(slackMention(`What does ${draft} change?`));
  await insertGitHubDraftWatch({ conversation, pullRequest: draft });
  return conversation;
}

/** Completed calls that mark a pull request ready, direct or deferred. */
function markReadyCalls(result: { toolCalls: ToolCall[] }) {
  return [
    ...completedToolCalls("github_updatePullRequest", result).map(
      (call) => call.input,
    ),
    ...completedToolCalls("executeTool", result)
      .map((call) => call.input as { arguments?: unknown; tool_name?: string })
      .filter((input) => input.tool_name === "github_updatePullRequest")
      .map((input) => input.arguments),
  ].filter((input) => (input as { draft?: unknown })?.draft === false);
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
  test("subscribes to an exact deployment before GitHub creates it", async ({
    run,
  }) => {
    const commitSha = "c610b5d6a88c9da5d65627a1cdb3829b05c14f75";
    const conversation = await run(
      slackMention(
        `Watch the Production deployment of getsentry/junior-prod for commit ${commitSha}. It may not exist yet; tell me when it succeeds, fails, or reports an error.`,
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply confirms the exact deployment target will be monitored through event-based updates.",
        ],
        fail: [
          "Do not claim a polling task or recurring schedule was created.",
          "Do not ask the user to wait and check GitHub manually.",
        ],
      }),
    );

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
        resource_type: "deployment_source",
      }),
    );
    expect(conversation.toolCalls.map((call) => call.name)).not.toContain(
      "createAutomation",
    );
  });

  test("when a PR can emit the requested events, subscribe instead of polling", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        `Check ${pullRequest} every five minutes and tell this thread if checks fail, review feedback arrives, it merges, or it closes.`,
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply confirms the pull request will be monitored through event-based updates for the requested outcomes.",
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
        resource_type: "pull_request",
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
      "createAutomation",
    );
  });

  test("when a watched event does not serve the intent, stay silent", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(`Let me know here when ${pullRequest} lands.`),
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
      slackMention(
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

  test("when a watch asks for a fix and the PR checks fail, push the fix and reply quietly", async ({
    run,
  }) => {
    // The fixture skill has a local checkout of the pull request branch.
    const conversation = await run(
      slackMention(
        `/github-headless-pr-fixture Watch ${pullRequest}. When its checks fail, fix the failure and push the update. Do not change anything before a check fails.`,
      ),
    );
    expect(
      watchedEvents(conversation),
      "No checks watch: this run does not test delivery",
    ).toContain("pull_request.checks.failed");

    const delivery = await conversation.continue(checkSuiteWebhook("failure"));
    // A routine fix that worked needs nobody, so it posts nothing to Slack.
    // The quiet reply stays in the Conversation.
    expect(delivery.replies).toEqual([]);
    expect(delivery.quietReplies).toHaveLength(1);
    expect(delivery.quietReplies[0]?.text).toMatch(/push/i);

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

  test("when the checks of a Junior draft pass, mark it ready and say so", async ({
    run,
  }) => {
    const conversation = await startDraftThread(run, 692);

    const delivery = await conversation.continue(draftChecksPassedWebhook(692));
    await expect(delivery).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: ["The reply says getsentry/junior#692 is now ready for review."],
        fail: [
          "Do not say that a required check failed.",
          "Do not ask the person whether to mark it ready.",
        ],
      }),
    );

    expect(markReadyCalls(delivery)).toHaveLength(1);
    expect(delivery.replies).toHaveLength(1);
  });

  test("when a Junior draft names an open decision, keep it a draft", async ({
    run,
  }) => {
    const conversation = await startDraftThread(run, 693);

    const delivery = await conversation.continue(draftChecksPassedWebhook(693));

    expect(delivery.turns).not.toHaveLength(0);
    expect(markReadyCalls(delivery)).toEqual([]);
    expect(delivery.replies).toEqual([]);
  });

  test("when another required check of a Junior draft fails, keep it a draft", async ({
    run,
  }) => {
    const conversation = await startDraftThread(run, 694);

    const delivery = await conversation.continue(draftChecksPassedWebhook(694));

    expect(delivery.turns).not.toHaveLength(0);
    expect(markReadyCalls(delivery)).toEqual([]);
  });

  test("when a watched PR is merged, report completion without extra work", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(`Let me know here when ${pullRequest} lands.`),
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

  test("when a watched PR merges after an Automation run, post with reply", async ({
    run,
  }) => {
    await insertScheduledAutomation({
      credentialMode: "system",
      destination: slackChannel(),
      due: true,
      once: true,
      task: `Post this reminder: ${pullRequest} is waiting for review.`,
    });
    const delivery = await run(heartbeat());
    expect(delivery.replies).toHaveLength(1);
    await insertWatch({
      conversation: delivery,
      events: ["pull_request.merged"],
      identifier: pullRequest,
      intent: "Tell this thread when the pull request merges.",
      label: `GitHub PR ${pullRequest}`,
      resourceType: "pull_request",
    });

    const merged = await delivery.continue(mergedWebhook());

    // Final text on an Automation run is not delivered, so only reply posts.
    expect(completedToolCalls("reply", merged)).toHaveLength(1);
    expect(merged.replies).toHaveLength(1);
  });

  test("when the merge guidance says to tell the person who asked, post it", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(`What does ${pullRequest} change?`),
    );
    // The Watch that Junior adds after it opens a pull request. The GitHub
    // plugin guidance for the merge says to mention the person who asked.
    await insertWatch({
      conversation,
      events: ["pull_request.merged"],
      identifier: pullRequest,
      intent:
        "Maintain pull requests Junior creates. For actionable review feedback or failed checks, inspect the evidence, make scoped fixes, verify them, and push. Report completed work or blockers in the originating Slack thread. Report when the pull request closes unmerged. When a reviewer submits a review, notify the person who asked for the pull request by @-mentioning their Slack user ID from the originating thread, with the reviewer, the review outcome, and the pull request link. Otherwise stay silent.",
      label: `GitHub PR ${pullRequest}`,
      resourceType: "pull_request",
    });

    const delivery = await conversation.continue(mergedWebhook());
    await expect(delivery).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          `The reply says GitHub PR ${pullRequest} was merged.`,
          "The reply mentions the person who asked in the thread.",
        ],
      }),
    );

    // The person must hear about the merge, so the reply is not quiet.
    expect(delivery.quietReplies).toEqual([]);
    expect(delivery.replies).toHaveLength(1);
  });

  test("when the person who asked reviews the PR, address them once as you", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(`Let me know here when ${pullRequest} lands.`),
    );
    // The Slack person who asked also reviews on GitHub as this login.
    await insertLinkedGitHubIdentity({ login: "octo-requester" });
    await insertWatch({
      conversation,
      events: ["pull_request.review.changes_requested"],
      identifier: pullRequest,
      intent:
        "When a reviewer submits a review, notify the person who asked for the pull request by @-mentioning their Slack user ID from the originating thread, with the reviewer, the review outcome, and the pull request link. Do not change the pull request.",
      label: `GitHub PR ${pullRequest}`,
      resourceType: "pull_request",
    });

    const delivery = await conversation.continue(
      githubWebhook("pull_request_review", {
        action: "submitted",
        pull_request: { number: 691 },
        repository,
        review: {
          body: "Please add a regression test.",
          state: "changes_requested",
          user: { login: "octo-requester" },
        },
      }),
    );
    await expect(delivery).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          `The reply says changes were requested on GitHub PR ${pullRequest}.`,
          "The reply treats the person it notifies as the reviewer, for example by saying that you requested changes.",
        ],
        fail: [
          "Do not present the reviewer as a different person from the person the reply notifies.",
          'Do not name "octo-requester" as the reviewer.',
        ],
      }),
    );

    expect(delivery.replies).toHaveLength(1);
    expect(delivery.replies[0]?.text).not.toMatch(/octo-requester/i);
  });

  test("when a child agent reports a review by the person who asked, address them once as you", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        `Use spawnAgent to start one child agent named "pr-watcher" with the task "Reply with only the word READY. A watch on ${pullRequest} sends you its reviews later." When it reports a review, @-mention me here with the reviewer, the review outcome, and the pull request link.`,
      ),
    );
    const [spawned] = completedToolCalls("spawnAgent", conversation).map(
      (call) => toolOutput(call) as { conversation_id?: string },
    );
    expect(
      spawned?.conversation_id,
      "No child agent: this run does not test the relay",
    ).toEqual(expect.any(String));
    // The Slack person who asked also reviews on GitHub as this login. The
    // child agent watches the PR, so the review reaches the thread only
    // through its result.
    await insertLinkedGitHubIdentity({ login: "octo-requester" });
    await insertWatch({
      conversation: { conversationId: spawned!.conversation_id! },
      events: ["pull_request.review.changes_requested"],
      identifier: pullRequest,
      intent:
        "Report each review to the parent agent with the reviewer, the review outcome, and the pull request link. Do not change the pull request.",
      label: `GitHub PR ${pullRequest}`,
      resourceType: "pull_request",
    });

    const delivery = await conversation.continue(
      githubWebhook("pull_request_review", {
        action: "submitted",
        pull_request: { number: 691 },
        repository,
        review: {
          body: "Please add a regression test.",
          state: "changes_requested",
          user: { login: "octo-requester" },
        },
      }),
    );
    await expect(delivery).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          `The reply says changes were requested on GitHub PR ${pullRequest}.`,
          "The reply treats the person it mentions as the reviewer, for example by saying that you requested changes.",
        ],
        fail: [
          "Do not present the reviewer as a different person from the person the reply mentions.",
          'Do not name "octo-requester" as the reviewer.',
        ],
      }),
    );

    expect(delivery.replies).toHaveLength(1);
    expect(delivery.replies[0]?.text).not.toMatch(/octo-requester/i);
  });

  test("when a bot comments on the PR of a child Thread, the Thread ends with noReply", async ({
    run,
  }) => {
    const thread = await startPullRequestThread(run, [
      "pull_request.comment.created",
    ]);

    // A preview deploy bot comments. Nothing needs a change or a person.
    const delivery = await thread.continue(
      githubWebhook("issue_comment", {
        action: "created",
        comment: {
          body: "[vc]: #preview\n**The latest updates on your projects.**\n| Name | Status | Preview |\n| junior-docs | Ready | [Visit Preview](https://junior-docs-git-fix.vercel.app) |",
          id: 9_001,
          user: { login: "vercel[bot]", type: "Bot" },
        },
        issue: {
          number: 691,
          pull_request: {
            url: "https://api.github.com/repos/getsentry/junior/pulls/691",
          },
        },
        repository,
        sender: { id: 35_613_825, login: "vercel[bot]", type: "Bot" },
      }),
    );

    expect(completedToolCalls("noReply", delivery)).toHaveLength(1);
    expect(completedToolCalls("reply", delivery)).toEqual([]);
  });

  test("when the PR of a child Thread is approved, the Thread replies to its parent", async ({
    run,
  }) => {
    const thread = await startPullRequestThread(run, [
      "pull_request.review.approved",
    ]);

    const delivery = await thread.continue(
      githubWebhook("pull_request_review", {
        action: "submitted",
        pull_request: { number: 691 },
        repository,
        review: {
          body: "Looks good.",
          state: "approved",
          user: { login: "octo-reviewer" },
        },
      }),
    );

    // A child's final response is not sent to the parent. Only `reply` is.
    expect(completedToolCalls("reply", delivery)).toHaveLength(1);
  });

  test("when directly mentioned during a watch delivery, answer the mention in its own turn", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(`Let me know here when ${pullRequest} lands.`),
    );
    expect(
      watchedEvents(conversation),
      "No merge watch: this run does not test delivery",
    ).toContain("pull_request.merged");

    // A watch delivery turn takes no steering input. The mention waits for
    // its own turn.
    const delivery = await conversation.continue(mergedWebhook(), {
      onProgress: sendDuringFirstModelRequest([
        slackMention(
          "The deployment owner is Alice. Tell the thread who owns the deployment.",
        ),
      ]),
    });
    await expect(delivery).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "A reply says Alice owns the deployment.",
          "The user's direct instruction is the focus of the final response.",
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
