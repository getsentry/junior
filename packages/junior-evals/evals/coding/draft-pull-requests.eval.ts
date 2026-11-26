import { describe, expect } from "vitest";
import { githubWebhook, slackMention } from "@junior-evals/fixture/inputs";
import {
  insertGitHubPullRequestWatch,
  insertLinkedGitHubIdentity,
} from "@junior-evals/fixture/insert";
import { completedToolCalls } from "@junior-evals/fixture/results";
import { test, type RunAgent, type ToolCall } from "@junior-evals/fixture/test";
import { repository, repositoryRef } from "./github-fixture";

// The shared GitHub HTTP fixture serves these drafts: #692 with every
// required check passing, #693 with an open decision in its body, #694
// with another required check failing, #696 with code owners for its
// changed file, and #697 whose base branch AGENTS.md asks for draft pull
// requests. The integration suite covers #695.
const draftHeadShas = {
  692: "6920000000000000000000000000000000000692",
  693: "6930000000000000000000000000000000000693",
  694: "6940000000000000000000000000000000000694",
  696: "6960000000000000000000000000000000000696",
  697: "6970000000000000000000000000000000000697",
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
  // The Slack person who asked reviews on GitHub as this login.
  await insertLinkedGitHubIdentity({ id: 7_002, login: "octo-requester" });
  await insertGitHubPullRequestWatch({
    conversation,
    draft: true,
    pullRequest: draft,
  });
  return conversation;
}

/** Completed pull request updates, direct or deferred. */
function updateCalls(result: { toolCalls: ToolCall[] }) {
  return [
    ...completedToolCalls("github_updatePullRequest", result).map(
      (call) => call.input,
    ),
    ...completedToolCalls("executeTool", result)
      .map((call) => call.input as { arguments?: unknown; tool_name?: string })
      .filter((input) => input.tool_name === "github_updatePullRequest")
      .map((input) => input.arguments),
  ] as Array<{ draft?: unknown; request_review?: unknown } | undefined>;
}

/** Completed calls that mark a pull request ready. */
function markReadyCalls(result: { toolCalls: ToolCall[] }) {
  return updateCalls(result).filter((input) => input?.draft === false);
}

/** Completed calls that ask the requester to review a pull request. */
function reviewAskCalls(result: { toolCalls: ToolCall[] }) {
  return updateCalls(result).filter((input) => input?.request_review === true);
}

describe("Watches", () => {
  test("when the checks of a Junior draft pass, mark it ready without posting", async ({
    run,
  }) => {
    const conversation = await startDraftThread(run, 692);

    const delivery = await conversation.continue(draftChecksPassedWebhook(692));

    // GitHub sends the review request, so a reply would only be a status
    // update.
    expect(markReadyCalls(delivery)).toHaveLength(1);
    expect(delivery.replies).toEqual([]);
  });

  // The review request gives the requester an Inbox item, so a reply would
  // ask them twice.
  test("when the checks of a Junior draft with code owners pass, keep it a draft and ask only the requester to review it", async ({
    run,
  }) => {
    const conversation = await startDraftThread(run, 696);

    const delivery = await conversation.continue(draftChecksPassedWebhook(696));

    expect(markReadyCalls(delivery)).toEqual([]);
    expect(reviewAskCalls(delivery)).toHaveLength(1);
    expect(delivery.replies).toEqual([]);
  });

  test("when the AGENTS.md of a Junior draft asks for drafts, keep it a draft and ask only the requester to review it", async ({
    run,
  }) => {
    const conversation = await startDraftThread(run, 697);

    const delivery = await conversation.continue(draftChecksPassedWebhook(697));

    expect(markReadyCalls(delivery)).toEqual([]);
    expect(reviewAskCalls(delivery)).toHaveLength(1);
    expect(delivery.replies).toEqual([]);
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
});
