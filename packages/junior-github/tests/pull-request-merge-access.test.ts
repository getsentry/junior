import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitHubFixture } from "./github-db";
import {
  SUBJECT,
  checkSuiteCompleted,
  mockGitHub,
  reviewSubmitted,
  route,
  seedJuniorPullRequest,
  stubGitHubAppEnv,
  type GitHubState,
  type InboxItemCall,
} from "./pull-request-action-harness";

// Only a requester with write access to the repository can merge, so only
// they get a merge ask.
describe("merge ask access", () => {
  beforeEach(() => {
    stubGitHubAppEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("gives no merge ask to a requester without write access, and asks for their review instead", async () => {
    const fixture = await createGitHubFixture();
    const calls: InboxItemCall[] = [];
    const requests: string[] = [];
    // The repo requires no review, so GitHub says that it can merge. The
    // requester can only read the repo, so a person with write access
    // merges it.
    const github: GitHubState = {
      draft: false,
      mergeableStates: ["clean"],
      merged: false,
      permissions: { Requester: "read" },
      reviews: [],
      state: "open",
    };
    mockGitHub(github, requests);
    try {
      await seedJuniorPullRequest(fixture, "slack:C123:1712345.0001");
      const webhook = route(fixture, calls);

      // The requester can still review it, so Junior asks for that.
      await webhook.handler(checkSuiteCompleted());
      expect(requests).toContain("request Requester");
      expect(calls).toMatchObject([
        { kind: "upsert", notice: { title: "Review requested · #946" } },
      ]);

      // Their approval ends the review, and no merge ask follows.
      github.requestedReviewers = [];
      github.reviews = [
        {
          state: "APPROVED",
          submitted_at: "2026-07-02T12:00:00.000Z",
          user: { login: "Requester" },
        },
      ];
      await webhook.handler(
        reviewSubmitted("approved", { login: "Requester" }),
      );
      await webhook.handler(checkSuiteCompleted());
      expect(calls.slice(1)).toEqual([
        {
          conversationId: "slack:C123:1712345.0001",
          input: {
            subject: SUBJECT,
            reason: "The review request ended.",
            status: "done",
          },
          kind: "close",
        },
      ]);
      // The access stays cached, so later syncs do not read it again.
      expect(
        requests.filter((request) => request.startsWith("permission")),
      ).toEqual(["permission Requester"]);
    } finally {
      await fixture.close();
    }
  });

  it("closes a merge ask when the requester has no write access", async () => {
    const fixture = await createGitHubFixture();
    const calls: InboxItemCall[] = [];
    const requests: string[] = [];
    const github: GitHubState = {
      draft: false,
      mergeableStates: ["clean"],
      merged: false,
      reviews: [
        {
          state: "APPROVED",
          submitted_at: "2026-07-02T12:00:00.000Z",
          user: { login: "Requester" },
        },
      ],
      state: "open",
    };
    mockGitHub(github, requests);
    try {
      await seedJuniorPullRequest(fixture, "slack:C123:1712345.0001");
      await route(fixture, calls).handler(checkSuiteCompleted());
      expect(calls).toMatchObject([
        { kind: "upsert", notice: { title: "Ready to merge · #946" } },
      ]);

      // The requester loses write access. A new route has an empty cache,
      // as after the cached access expires.
      github.permissions = { Requester: "read" };
      await route(fixture, calls).handler(checkSuiteCompleted());
      expect(calls.slice(1)).toEqual([
        {
          conversationId: "slack:C123:1712345.0001",
          input: {
            subject: SUBJECT,
            reason: "Only a person with write access can merge it.",
            status: "dismissed",
          },
          kind: "close",
        },
      ]);
    } finally {
      await fixture.close();
    }
  });
});
