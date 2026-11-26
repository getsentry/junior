import { afterEach, describe, expect, it } from "vitest";
import { closeDb } from "@/chat/db";
import {
  cardNode,
  createGitHubApp,
  GITHUB_REPO,
  linkGitHubMember,
  pullRequest,
  sendGitHubWebhook,
  stubGitHubApp,
  stubGraphql,
  viewerApi,
} from "../../fixtures/github-objects";
import { createPluginTaskQueueTestAdapter } from "../../fixtures/plugin-task-queue";

describe("GitHub pull request review decision cache", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("reads the review decision again after an older review request webhook", async () => {
    stubGitHubApp();
    const queries = stubGraphql({
      cards: [{ ...cardNode(34), reviewDecision: "APPROVED" }],
    });
    const app = await createGitHubApp(createPluginTaskQueueTestAdapter());
    await linkGitHubMember();
    const read = await viewerApi("alice@example.com");
    const url = `${GITHUB_REPO}/pull/34`;
    await read(url);

    // GitHub delivers a review request late, after the card read stored a
    // newer pull request.
    await sendGitHubWebhook(app, "pull_request", {
      action: "review_requested",
      pull_request: pullRequest(34, {
        updated_at: "2026-01-02T05:59:00Z",
      }),
    });
    await read(url);
    expect(queries.map((query) => query.operationName)).toEqual([
      "PullRequestCards",
      "PullRequestCards",
    ]);
  });
});
