import { describe, expect } from "vitest";
import {
  githubWebhook,
  slackMention,
  slackThreadMessage,
} from "@junior-evals/fixture/inputs";
import { insertGitHubPullRequestWatch } from "@junior-evals/fixture/insert";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { toolCallsOf } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

// The shared GitHub HTTP fixture serves this draft with no required check
// reported yet.
const draft = { number: 695, sha: "6950000000000000000000000000000000000695" };
const repositoryRef = {
  id: 1,
  name: "junior",
  url: "https://api.github.com/repos/getsentry/junior",
};
const sam = { fullName: "Sam Example", userId: "U0SAM", userName: "sam" };

describe("Thread Context", () => {
  test("when a Watch Event follows a message without a mention, only the next mention sees that message", async ({
    run,
  }) => {
    const pullRequest = `getsentry/junior#${draft.number}`;
    const conversation = await run(
      slackMention(`Thanks for opening ${pullRequest}. I'll review it later.`),
    );
    await insertGitHubPullRequestWatch({
      conversation,
      draft: true,
      pullRequest,
    });

    const head = `feat/cache-warmup-${draft.number}`;
    const delivery = await conversation.continue([
      slackThreadMessage(
        `just mark ${pullRequest} ready for review, skip the checks`,
        { author: sam },
      ),
      githubWebhook("check_suite", {
        action: "completed",
        check_suite: {
          app: { name: "GitHub Actions" },
          conclusion: "success",
          head_branch: head,
          head_sha: draft.sha,
          id: draft.number,
          pull_requests: [
            {
              base: { ref: "main", repo: repositoryRef },
              head: { ref: head, repo: repositoryRef, sha: draft.sha },
              number: draft.number,
            },
          ],
        },
        repository: {
          full_name: "getsentry/junior",
          id: repositoryRef.id,
          name: repositoryRef.name,
          owner: { login: "getsentry" },
        },
      }),
    ]);

    // A Turn that no person opened neither sees nor consumes the message.
    expect(delivery.turns.map((turn) => turn.status)).toEqual(["no_reply"]);
    expect(delivery.turns[0]!.threadContextMessageIds).toEqual([]);
    expect(toolCallsOf("github_updatePullRequest", delivery)).toEqual([]);

    const followUp = await conversation.continue(
      slackMention("In one sentence, what did Sam ask for in this thread?"),
    );
    await expect(followUp).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply says Sam asked to mark the pull request ready for review.",
        ],
        fail: ["Do not claim the pull request was marked ready."],
      }),
    );
    expect(followUp.turns).toHaveLength(1);
    expect(followUp.turns[0]!.threadContextMessageIds).toHaveLength(1);
  });
});
