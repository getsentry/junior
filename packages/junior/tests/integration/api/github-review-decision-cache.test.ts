import { afterEach, describe, expect, it, vi } from "vitest";
import { closeDb } from "@/chat/db";
import {
  cardNode,
  checkRuns,
  createGitHubApp,
  GITHUB_REPO,
  linkGitHubMember,
  pullRequest,
  sendGitHubWebhook,
  stubGitHubApp,
  stubGraphql,
  T0,
  viewerApi,
} from "../../fixtures/github-objects";
import { createPluginTaskQueueTestAdapter } from "../../fixtures/plugin-task-queue";

describe("GitHub pull request review decision cache", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await closeDb();
  });

  it("patches the review decision after a review, into the card that a check stored", async () => {
    stubGitHubApp();
    const queries = stubGraphql({
      cards: [{ ...cardNode(34), headRefOid: "aaa111" }],
      patches: [
        [
          {
            commits: checkRuns({ SUCCESS: 2 }),
            headRefOid: "aaa111",
            mergeable: "MERGEABLE",
            number: 34,
            reviewDecision: "APPROVED",
            updatedAt: "2026-01-02T06:00:00Z",
          },
        ],
      ],
    });
    const tasks = createPluginTaskQueueTestAdapter();
    const app = await createGitHubApp(tasks);
    await linkGitHubMember();
    const read = await viewerApi("alice@example.com");
    const url = `${GITHUB_REPO}/pull/34`;
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse(T0);
    vi.setSystemTime(start);

    // No entry has the head commit of the check, so its patch stores the
    // whole card.
    await sendGitHubWebhook(app, "check_run", {
      action: "completed",
      check_run: {
        conclusion: "success",
        head_sha: "aaa111",
        id: 8001,
        pull_requests: [{ id: 34000, number: 34 }],
        status: "completed",
      },
    });
    vi.setSystemTime(start + 60_000);
    await tasks.deliver();
    expect(queries).toEqual([
      { numbers: [34], operationName: "PullRequestCards" },
    ]);
    expect((await read(url)).objects.get(url)).toMatchObject({
      facts: { checks: { failed: 0, passed: 2, pending: 0 } },
      title: "Renamed 34",
    });

    // A review clears the decision, and its patch reads it again.
    vi.setSystemTime(start + 120_000);
    await sendGitHubWebhook(app, "pull_request_review", {
      action: "submitted",
      pull_request: { head: { sha: "aaa111" }, id: 34000, number: 34 },
      review: { state: "approved", user: { login: "sam" } },
    });
    vi.setSystemTime(start + 180_000);
    await tasks.deliver();
    expect((await read(url)).objects.get(url)?.facts).toMatchObject({
      review: "approved",
    });
    // The page reads asked GitHub nothing.
    expect(queries).toEqual([
      { numbers: [34], operationName: "PullRequestCards" },
      { numbers: [34], operationName: "PullRequestHeadFacts" },
    ]);
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
