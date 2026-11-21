import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitHubFixture } from "./github-db";
import {
  DEDUPE_KEY,
  PULL_URL,
  commented,
  markReviewAddressed,
  mockGitHub,
  pullRequestAction,
  reviewRequested,
  repository,
  reviewSubmitted,
  route,
  seedJuniorPullRequest,
  signedRequest,
  stubGitHubAppEnv,
  type GitHubState,
  type InboxItemCall,
} from "./pull-request-action-harness";

describe("review again after a change request", () => {
  beforeEach(() => {
    stubGitHubAppEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("checks the next action on a team review request", async () => {
    const fixture = await createGitHubFixture();
    const calls: InboxItemCall[] = [];
    mockGitHub(
      {
        draft: false,
        mergeableStates: ["blocked"],
        merged: false,
        requestedReviewers: ["Requester"],
        reviews: [],
        state: "open",
      },
      [],
    );
    try {
      await seedJuniorPullRequest(fixture, "slack:C123:1712345.0001");
      // GitHub sends `requested_reviewer: null` when it asks a team.
      await route(fixture, calls).handler(
        signedRequest(
          {
            action: "review_requested",
            pull_request: { number: 946, updated_at: "2026-07-02T10:00:00Z" },
            repository,
            requested_reviewer: null,
            requested_team: { slug: "reviewers" },
            sender: { login: "sentry-junior[bot]" },
          },
          "pull_request",
        ),
      );
      expect(calls).toMatchObject([
        { kind: "upsert", notice: { title: "Review requested · #946" } },
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("asks the requester again after a push that follows their change request", async () => {
    const fixture = await createGitHubFixture();
    const calls: InboxItemCall[] = [];
    const requests: string[] = [];
    const github: GitHubState = {
      draft: false,
      mergeableStates: ["blocked"],
      merged: false,
      requestedReviewers: ["Requester"],
      reviews: [],
      state: "open",
    };
    mockGitHub(github, requests);
    try {
      await seedJuniorPullRequest(fixture, "slack:C123:1712345.0001");
      const webhook = route(fixture, calls);
      await webhook.handler(pullRequestAction("review_requested"));
      expect(calls.at(-1)).toMatchObject({
        kind: "upsert",
        notice: { title: "Review requested · #946" },
      });

      // The requester asks for changes, so GitHub stops asking them.
      github.requestedReviewers = [];
      github.reviews = [
        {
          commit_id: "head-1",
          id: 301,
          state: "CHANGES_REQUESTED",
          user: { login: "requester" },
        },
      ];
      await webhook.handler(reviewSubmitted("changes_requested"));
      const ended = {
        conversationId: "slack:C123:1712345.0001",
        input: {
          dedupeKey: DEDUPE_KEY,
          reason: "The review request ended.",
          status: "done",
        },
        kind: "close",
      };
      expect(calls.at(-1)).toEqual(ended);

      // Junior pushes the fix. The requester's change request is on an older
      // commit, so the review is wanted again, and GitHub asks for it.
      github.headSha = "head-2";
      requests.length = 0;
      await webhook.handler(pullRequestAction("synchronize"));
      expect(requests).toContain("request Requester");
      expect(calls.at(-1)).toEqual({
        conversationId: "slack:C123:1712345.0001",
        kind: "upsert",
        notice: {
          assigneeIdentityIds: ["identity-requester"],
          body: `#946 has new commits since you requested changes.\n\n${PULL_URL}`,
          dedupeKey: DEDUPE_KEY,
          subject: {
            id: PULL_URL,
            title: "Add the Inbox notice (#946)",
            url: PULL_URL,
          },
          title: "Review requested · #946",
          waitsOnAssignees: true,
        },
      });

      // Junior marks the change request addressed, and asks its author to
      // review again. GitHub then asks for the review, so the item stays.
      requests.length = 0;
      await markReviewAddressed(301);
      expect(requests).toEqual(["pull", "reviews", "request requester"]);
      await webhook.handler(pullRequestAction("review_requested"));
      expect(calls).toHaveLength(3);

      // The approval ends the review.
      github.requestedReviewers = [];
      github.reviews.push({
        commit_id: "head-2",
        id: 302,
        state: "APPROVED",
        user: { login: "requester" },
      });
      await webhook.handler(reviewSubmitted("approved"));
      expect(calls.at(-1)).toEqual(ended);
    } finally {
      await fixture.close();
    }
  });

  it("asks the requester again when Junior replies to their change request with no push, until they reply", async () => {
    const fixture = await createGitHubFixture();
    const calls: InboxItemCall[] = [];
    const requests: string[] = [];
    const github: GitHubState = {
      draft: false,
      mergeableStates: ["blocked"],
      merged: false,
      requestedReviewers: [],
      reviews: [
        {
          commit_id: "head-1",
          id: 301,
          state: "CHANGES_REQUESTED",
          submitted_at: "2026-07-02T10:00:00Z",
          user: { login: "requester" },
        },
      ],
      state: "open",
    };
    mockGitHub(github, requests);
    try {
      await seedJuniorPullRequest(fixture, "slack:C123:1712345.0001");
      const webhook = route(fixture, calls);
      // The requester asks a question with a change request.
      await webhook.handler(
        reviewSubmitted("changes_requested", {
          at: "2026-07-02T10:00:00Z",
          login: "Requester",
        }),
      );
      expect(calls).toEqual([]);

      // A comment by another person changes nothing, and reads nothing.
      requests.length = 0;
      await webhook.handler(
        commented(github, "issue_comment", {
          at: "2026-07-02T10:30:00Z",
          login: "someone-else",
        }),
      );
      expect(requests).toEqual([]);

      // Junior answers in a comment and pushes nothing. The requester's
      // review is wanted again, in the Inbox and on GitHub.
      await webhook.handler(
        commented(github, "issue_comment", {
          at: "2026-07-02T11:00:00Z",
          login: "sentry-junior[bot]",
        }),
      );
      expect(requests).toEqual(["pull", "request Requester"]);
      const asked = {
        conversationId: "slack:C123:1712345.0001",
        kind: "upsert",
        notice: {
          assigneeIdentityIds: ["identity-requester"],
          body: `#946 has a reply since you requested changes.\n\n${PULL_URL}`,
          dedupeKey: DEDUPE_KEY,
          subject: {
            id: PULL_URL,
            title: "Add the Inbox notice (#946)",
            url: PULL_URL,
          },
          title: "Review requested · #946",
          waitsOnAssignees: true,
        },
      };
      expect(calls).toEqual([asked]);
      await webhook.handler(
        reviewRequested(github, "Requester", "2026-07-02T11:00:01Z"),
      );
      expect(calls).toEqual([asked]);

      // The requester replies. Junior acts next, so the item closes, though
      // GitHub still asks for the review.
      await webhook.handler(
        commented(github, "pull_request_review_comment", {
          at: "2026-07-02T12:00:00Z",
          login: "Requester",
        }),
      );
      expect(calls.at(-1)).toEqual({
        conversationId: "slack:C123:1712345.0001",
        input: {
          dedupeKey: DEDUPE_KEY,
          reason: "The review request ended.",
          status: "done",
        },
        kind: "close",
      });

      // Junior replies in the review thread, so the review is wanted again.
      // GitHub already asks for it, so Junior does not ask twice.
      requests.length = 0;
      await webhook.handler(
        commented(github, "pull_request_review_comment", {
          at: "2026-07-02T13:00:00Z",
          login: "sentry-junior[bot]",
        }),
      );
      expect(calls.at(-1)).toMatchObject({
        kind: "upsert",
        notice: { title: "Review requested · #946" },
      });
      expect(calls).toHaveLength(3);
      expect(requests).not.toContain("request Requester");
    } finally {
      await fixture.close();
    }
  });

  it("asks the requester again when a change request is addressed with no push", async () => {
    const fixture = await createGitHubFixture();
    const calls: InboxItemCall[] = [];
    const github: GitHubState = {
      draft: false,
      mergeableStates: ["blocked"],
      merged: false,
      requestedReviewers: [],
      reviews: [
        {
          commit_id: "head-1",
          id: 301,
          state: "CHANGES_REQUESTED",
          user: { login: "requester" },
        },
      ],
      state: "open",
    };
    mockGitHub(github, []);
    try {
      await seedJuniorPullRequest(fixture, "slack:C123:1712345.0001");
      const webhook = route(fixture, calls);
      // The change request is on the head commit, so nothing is new yet.
      await webhook.handler(reviewSubmitted("changes_requested"));
      expect(calls).toEqual([]);

      // Junior answers without a push, such as when the code was already
      // right. GitHub asks the requester again, and the item comes back.
      await markReviewAddressed(301);
      await webhook.handler(pullRequestAction("review_requested"));
      expect(calls).toEqual([
        {
          conversationId: "slack:C123:1712345.0001",
          kind: "upsert",
          notice: expect.objectContaining({
            body: `GitHub asks you to review #946.\n\n${PULL_URL}`,
            title: "Review requested · #946",
          }),
        },
      ]);
    } finally {
      await fixture.close();
    }
  });

  it.each([
    {
      name: "an approval",
      reviews: [{ id: 301, state: "APPROVED" }],
      webhookState: "approved" as const,
    },
    {
      name: "a comment",
      reviews: [{ id: 301, state: "COMMENTED" }],
      webhookState: "commented" as const,
    },
    {
      // With auto-merge on, a push after the approval can merge with no
      // other person, so asking again would only bother the requester.
      autoMerge: true,
      name: "an approval that follows a change request",
      reviews: [
        { id: 301, state: "CHANGES_REQUESTED" },
        { id: 302, state: "APPROVED" },
      ],
      webhookState: "approved" as const,
    },
  ])(
    "does not ask the requester again after $name",
    async ({ autoMerge, reviews, webhookState }) => {
      const fixture = await createGitHubFixture();
      const calls: InboxItemCall[] = [];
      const requests: string[] = [];
      const github: GitHubState = {
        autoMerge,
        draft: false,
        mergeableStates: ["blocked"],
        merged: false,
        requestedReviewers: [],
        reviews: reviews.map((review) => ({
          ...review,
          commit_id: "head-1",
          user: { login: "requester" },
        })),
        state: "open",
      };
      mockGitHub(github, requests);
      try {
        await seedJuniorPullRequest(fixture, "slack:C123:1712345.0001");
        const webhook = route(fixture, calls);
        await webhook.handler(reviewSubmitted(webhookState));
        await markReviewAddressed(301);
        github.headSha = "head-2";
        await webhook.handler(pullRequestAction("synchronize"));
        expect(requests).not.toContain("request requester");
        expect(calls).toEqual([]);
      } finally {
        await fixture.close();
      }
    },
  );
});
