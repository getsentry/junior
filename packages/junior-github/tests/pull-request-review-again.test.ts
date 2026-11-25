import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitHubFixture } from "./github-db";
import { memoryState } from "./plugin-harness";
import {
  DEDUPE_KEY,
  PULL_URL,
  checkSuiteCompleted,
  commented,
  markFeedback,
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

  it("asks the requester again only after Junior marks every comment of their change request, not after a push", async () => {
    const fixture = await createGitHubFixture();
    const calls: InboxItemCall[] = [];
    const requests: string[] = [];
    const state = memoryState();
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
      const webhook = route(fixture, calls, [], { close: 0 }, [], state);
      await webhook.handler(pullRequestAction("review_requested"));
      expect(calls.at(-1)).toMatchObject({
        kind: "upsert",
        notice: { title: "Review requested · #946" },
      });

      // The requester asks for changes, so GitHub stops asking them.
      github.requestedReviewers = [];
      github.reviews = [
        {
          comments: [401],
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

      // Junior pushes the fix. A push alone does not ask.
      github.headSha = "head-2";
      requests.length = 0;
      await webhook.handler(pullRequestAction("synchronize"));
      expect(requests).not.toContain("request requester");
      expect(calls.at(-1)).toEqual(ended);

      // Junior marks the body. The inline comment is still open.
      await markFeedback(state, { id: 301, kind: "review_body" });
      expect(requests).not.toContain("request requester");

      // Junior marks the last comment, and asks its author to review again.
      // GitHub then asks for the review, so the item comes back.
      await markFeedback(state, { id: 401, kind: "review" });
      expect(requests).toContain("request requester");
      await webhook.handler(pullRequestAction("review_requested"));
      expect(calls.at(-1)).toEqual({
        conversationId: "slack:C123:1712345.0001",
        kind: "upsert",
        notice: {
          assigneeIdentityIds: ["identity-requester"],
          body: `Every comment on your change request is handled.\n\n${PULL_URL}`,
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

  it("asks the requester again when Junior answers their change request and marks it addressed, until they reply", async () => {
    const fixture = await createGitHubFixture();
    const calls: InboxItemCall[] = [];
    const requests: string[] = [];
    const state = memoryState();
    const github: GitHubState = {
      draft: false,
      mergeableStates: ["blocked"],
      merged: false,
      requestedReviewers: [],
      reviews: [
        {
          body: "Why does this need a new table?",
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
      const webhook = route(fixture, calls, [], { close: 0 }, [], state);
      // The requester asks a question with a change request.
      await webhook.handler(
        reviewSubmitted("changes_requested", {
          at: "2026-07-02T10:00:00Z",
          login: "Requester",
        }),
      );
      expect(calls).toEqual([]);

      // Comments by another person and by Junior change nothing, and read
      // nothing. A reply alone does not ask.
      requests.length = 0;
      await webhook.handler(
        commented(github, "issue_comment", {
          at: "2026-07-02T10:30:00Z",
          login: "someone-else",
        }),
      );
      await webhook.handler(
        commented(github, "issue_comment", {
          at: "2026-07-02T11:00:00Z",
          login: "sentry-junior[bot]",
        }),
      );
      expect(requests).toEqual([]);
      expect(calls).toEqual([]);

      // Junior marks the answered change request addressed. The requester's
      // review is wanted again, on GitHub and in the Inbox.
      await markFeedback(state, { id: 301, kind: "review_body" });
      expect(requests).toContain("request requester");
      const asked = {
        conversationId: "slack:C123:1712345.0001",
        kind: "upsert",
        notice: expect.objectContaining({
          body: `Every comment on your change request is handled.\n\n${PULL_URL}`,
          title: "Review requested · #946",
        }),
      };
      await webhook.handler(
        reviewRequested(github, "requester", "2026-07-02T11:00:01Z"),
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

      // Junior's reply in the review thread alone does not ask again.
      await webhook.handler(
        commented(github, "pull_request_review_comment", {
          at: "2026-07-02T13:00:00Z",
          login: "sentry-junior[bot]",
        }),
      );
      expect(calls).toHaveLength(2);
    } finally {
      await fixture.close();
    }
  });

  it("asks once the last inline comment is marked though GitHub's read lags, and retries a rejected request", async () => {
    const fixture = await createGitHubFixture();
    const calls: InboxItemCall[] = [];
    const requests: string[] = [];
    const state = memoryState();
    const github: GitHubState = {
      checks: [{ conclusion: "SUCCESS", name: "test", status: "COMPLETED" }],
      draft: false,
      mergeableStates: ["blocked"],
      merged: false,
      requestedReviewers: [],
      requiredChecks: ["test"],
      reviews: [
        {
          body: "",
          comments: [401, 402],
          commit_id: "head-1",
          id: 301,
          state: "CHANGES_REQUESTED",
          user: { login: "requester" },
        },
      ],
      state: "open",
    };
    mockGitHub(github, requests);
    try {
      await seedJuniorPullRequest(fixture, "slack:C123:1712345.0001");
      const webhook = route(fixture, calls, [], { close: 0 }, [], state);
      await webhook.handler(reviewSubmitted("changes_requested"));
      await markFeedback(state, { id: 401, kind: "review" });
      expect(requests).not.toContain("request requester");

      // GitHub's read does not show the last mark yet, and GitHub rejects
      // the request. Nothing asks, and the ask waits.
      github.laggingFeedback = ["comment:402"];
      github.rejectReviewRequests = true;
      await markFeedback(state, { id: 402, kind: "review" });
      expect(requests).toContain("rejected requester");
      expect(requests).not.toContain("request requester");

      // The next webhook asks again, though the read still lags, and the
      // item says why.
      github.rejectReviewRequests = false;
      await webhook.handler(checkSuiteCompleted());
      expect(requests).toContain("request requester");
      expect(calls).toEqual([
        {
          conversationId: "slack:C123:1712345.0001",
          kind: "upsert",
          notice: expect.objectContaining({
            body: `Every comment on your change request is handled.\n\n${PULL_URL}`,
            title: "Review requested · #946",
          }),
        },
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("asks the requester again when a change request is addressed with no push", async () => {
    const fixture = await createGitHubFixture();
    const calls: InboxItemCall[] = [];
    const state = memoryState();
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
      const webhook = route(fixture, calls, [], { close: 0 }, [], state);
      // The change request is on the head commit, so nothing is new yet.
      await webhook.handler(reviewSubmitted("changes_requested"));
      expect(calls).toEqual([]);

      // Junior answers without a push, such as when the code was already
      // right. GitHub asks the requester again, and the item comes back.
      await markFeedback(state, { id: 301, kind: "review_body" });
      await webhook.handler(pullRequestAction("review_requested"));
      expect(calls).toEqual([
        {
          conversationId: "slack:C123:1712345.0001",
          kind: "upsert",
          notice: expect.objectContaining({
            body: `Every comment on your change request is handled.\n\n${PULL_URL}`,
            title: "Review requested · #946",
          }),
        },
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("replays getsentry/junior#3941: asks again only when every comment of the latest change request is marked and the required checks pass", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const at = (time: string) => `2026-11-21T${time}Z`;
    const fixture = await createGitHubFixture();
    const calls: InboxItemCall[] = [];
    const requests: string[] = [];
    const state = memoryState();
    const passing = [
      { conclusion: "SUCCESS", name: "test", status: "COMPLETED" },
    ];
    const pending = [{ conclusion: null, name: "test", status: "IN_PROGRESS" }];
    const github: GitHubState = {
      checks: passing,
      draft: false,
      headSha: "head-1",
      mergeableStates: ["blocked"],
      merged: false,
      requestedReviewers: [],
      requiredChecks: ["test"],
      reviews: [],
      state: "open",
    };
    mockGitHub(github, requests);
    const asks = () =>
      requests.filter((request) => request.startsWith("request "));
    const push = async (headSha: string, time: string) => {
      vi.setSystemTime(new Date(at(time)));
      github.headSha = headSha;
      github.checks = pending;
      await webhook.handler(pullRequestAction("synchronize"));
    };
    const requestChanges = async (
      review: Omit<GitHubState["reviews"][number], "state" | "user">,
      time: string,
    ) => {
      vi.setSystemTime(new Date(at(time)));
      github.reviews.push({
        ...review,
        state: "CHANGES_REQUESTED",
        submitted_at: at(time),
        user: { login: "Requester" },
      });
      await webhook.handler(
        reviewSubmitted("changes_requested", {
          at: at(time),
          login: "Requester",
        }),
      );
    };
    const mark = async (
      target: { id: number; kind: "review" | "review_body" },
      time: string,
      status: "addressed" | "declined" = "addressed",
    ) => {
      vi.setSystemTime(new Date(at(time)));
      await markFeedback(state, target, status);
    };
    const webhook = route(fixture, calls, [], { close: 0 }, [], state);
    try {
      await seedJuniorPullRequest(fixture, "slack:C123:1712345.0001");

      // 17:48 The requester requests changes in a body and two comments.
      await requestChanges(
        {
          body: "A few things.",
          comments: [401, 402],
          commit_id: "head-1",
          id: 301,
        },
        "17:48:00",
      );
      // 17:50 Junior merges main into the branch. A sync push asks nothing.
      await push("head-2", "17:50:00");
      expect(asks()).toEqual([]);
      expect(calls).toEqual([]);

      // Junior marks the body and one comment. One comment is still open.
      await mark({ id: 301, kind: "review_body" }, "17:58:00");
      await mark({ id: 401, kind: "review" }, "17:59:00");
      expect(asks()).toEqual([]);

      // 18:01:20 A commit lands. 18:02:01 The requester requests changes
      // again, on the older head that they reviewed.
      await push("head-3", "18:01:20");
      await requestChanges(
        { body: "", comments: [403], commit_id: "head-2", id: 302 },
        "18:02:01",
      );
      expect(asks()).toEqual([]);

      // Junior finishes the first change request. It is no longer the
      // latest, so the new comment is still open.
      await mark({ id: 402, kind: "review" }, "18:05:00");
      expect(asks()).toEqual([]);

      // 18:34 A fix lands. Junior declines the last comment while the
      // checks run, so the ask waits for them.
      await push("head-4", "18:34:00");
      await mark({ id: 403, kind: "review" }, "18:34:30", "declined");
      expect(asks()).toEqual([]);

      // 18:36 Junior merges main again, and the checks fail.
      await push("head-5", "18:36:00");
      github.checks = [
        { conclusion: "FAILURE", name: "test", status: "COMPLETED" },
      ];
      await webhook.handler(checkSuiteCompleted("failure"));
      expect(asks()).toEqual([]);
      expect(calls).toEqual([]);

      // Junior fixes the checks. When they pass, the requester is asked.
      await push("head-6", "18:45:00");
      expect(asks()).toEqual([]);
      vi.setSystemTime(new Date(at("18:50:00")));
      github.checks = passing;
      await webhook.handler(checkSuiteCompleted());
      expect(asks()).toEqual(["request Requester"]);
      expect(calls).toEqual([
        {
          conversationId: "slack:C123:1712345.0001",
          kind: "upsert",
          notice: expect.objectContaining({
            body: `Checks now pass, and every comment is handled.\n\n${PULL_URL}`,
            title: "Review requested · #946",
          }),
        },
      ]);

      // GitHub's review request keeps the item, and asks nothing twice.
      await webhook.handler(
        reviewRequested(github, "Requester", at("18:50:01")),
      );
      await webhook.handler(checkSuiteCompleted());
      expect(asks()).toEqual(["request Requester"]);
      expect(calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      await fixture.close();
    }
  });

  it("drops an ask that waits for the checks when the requester comments first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fixture = await createGitHubFixture();
    const calls: InboxItemCall[] = [];
    const requests: string[] = [];
    const state = memoryState();
    const github: GitHubState = {
      checks: [{ conclusion: null, name: "test", status: "QUEUED" }],
      draft: false,
      mergeableStates: ["blocked"],
      merged: false,
      requestedReviewers: [],
      requiredChecks: ["test"],
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
      const webhook = route(fixture, calls, [], { close: 0 }, [], state);
      vi.setSystemTime(new Date("2026-07-02T11:00:00Z"));
      await markFeedback(state, { id: 301, kind: "review_body" });
      // The requester asks something more before the checks pass. Junior
      // acts next, so the waiting ask ends.
      await webhook.handler(
        commented(github, "issue_comment", {
          at: "2026-07-02T11:05:00Z",
          login: "Requester",
        }),
      );
      github.checks = [
        { conclusion: "SUCCESS", name: "test", status: "COMPLETED" },
      ];
      await webhook.handler(checkSuiteCompleted());
      expect(requests).not.toContain("request requester");
      expect(calls).toEqual([]);
    } finally {
      vi.useRealTimers();
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
      const state = memoryState();
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
        const webhook = route(fixture, calls, [], { close: 0 }, [], state);
        await webhook.handler(reviewSubmitted(webhookState));
        await markFeedback(state, { id: 301, kind: "review_body" });
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
