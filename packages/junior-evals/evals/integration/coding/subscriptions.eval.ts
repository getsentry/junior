import { describe, expect } from "vitest";
import { githubWebhook, slackMention } from "@junior-evals/fixture/inputs";
import { insertGitHubPullRequestWatch } from "@junior-evals/fixture/insert";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { completedToolCalls, toolOutput } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

// The shared GitHub HTTP fixture serves this draft with no required check
// reported yet.
const draft = { number: 695, sha: "6950000000000000000000000000000000000695" };
const repositoryRef = {
  id: 1,
  name: "junior",
  url: "https://api.github.com/repos/getsentry/junior",
};

describe("Watches", () => {
  test("when a draft's checks pass before its required checks report, post nothing", async ({
    run,
  }) => {
    const pullRequest = `getsentry/junior#${draft.number}`;
    // A setup message that needs no lookups, so the first Turn stays short.
    const conversation = await run(
      slackMention(`Thanks for opening ${pullRequest}. I'll review it later.`),
    );
    await insertGitHubPullRequestWatch({
      conversation,
      draft: true,
      pullRequest,
    });

    const head = `feat/cache-warmup-${draft.number}`;
    const delivery = await conversation.continue(
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
    );

    // getPullRequest reads the draft, and the Turn ends with noReply. Neither
    // the read nor the note posts anything to the thread.
    expect(delivery.turns.map((turn) => turn.status)).toEqual(["no_reply"]);
    expect(completedToolCalls("noReply", delivery)).toHaveLength(1);
    expect(delivery.replies).toEqual([]);
  });

  test("when a follow-up stops monitoring, cancel the selected watch before confirming", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "Watch the checks and review feedback on getsentry/junior#691, and keep me posted here.",
      ),
    );
    const [watch] = completedToolCalls("watchEvents", conversation).map(
      (call) => toolOutput(call) as { id: string },
    );
    expect(watch?.id, "No watch: this run does not test stopping").toEqual(
      expect.any(String),
    );

    // A bare "stop" opts Junior out of the thread before any turn runs. This
    // follow-up needs the conversation to mean "stop the watch".
    const stopped = await conversation.continue(
      slackMention("you can stop now"),
    );
    await expect(stopped).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "Junior understands from the conversation that the terse follow-up asks it to stop monitoring the pull request.",
          "Junior briefly confirms that monitoring stopped.",
        ],
        fail: [
          "Do not require the user to repeat a special unsubscribe phrase.",
          "Do not ask which resource the user meant when the active monitoring target is clear from the conversation.",
        ],
      }),
    );

    // The model can stop the watch directly or from a codemode script, so
    // check the active watches instead of the call.
    expect(stopped.watchIds).not.toContain(watch!.id);
  });
});
