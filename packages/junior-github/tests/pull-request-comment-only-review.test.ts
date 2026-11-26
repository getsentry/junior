import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markGitHubReviewAsked } from "../src/pull-request-review-again";
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
  reviewSubmitted,
  route,
  seedJuniorPullRequest,
  stubGitHubAppEnv,
  type GitHubState,
  type InboxItemCall,
} from "./pull-request-action-harness";

// The requester's comment-only review, which Junior handles like a change
// request (`src/webhooks/pull-request-next-action.ts`).
describe("review again after a comment-only review", () => {
  beforeEach(() => {
    stubGitHubAppEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("handles the requester's comment-only review like a change request, also a reply after Junior asks again", async () => {
    const fixture = await createGitHubFixture();
    const calls: InboxItemCall[] = [];
    const requests: string[] = [];
    const state = memoryState();
    const github: GitHubState = {
      draft: false,
      // A clean merge state still waits on Junior's answer.
      mergeableStates: ["clean"],
      merged: false,
      requestedReviewers: ["Requester"],
      reviewRequests: [{ at: "2026-07-02T10:00:00Z", login: "Requester" }],
      reviews: [],
      state: "open",
    };
    mockGitHub(github, requests);
    const asks = () =>
      requests.filter((request) => request.startsWith("request"));
    const reviewItem = (body: string) => ({
      conversationId: "slack:C123:1712345.0001",
      kind: "upsert",
      notice: expect.objectContaining({
        body: `${body}\n\n${PULL_URL}`,
        title: "Review requested · #946",
      }),
    });
    const ended = {
      conversationId: "slack:C123:1712345.0001",
      input: {
        dedupeKey: DEDUPE_KEY,
        reason: "The review request ended.",
        status: "done",
      },
      kind: "close",
    };
    try {
      await seedJuniorPullRequest(fixture, "slack:C123:1712345.0001");
      const webhook = route(fixture, calls, [], { close: 0 }, [], state);
      // A plain comment keeps GitHub's request.
      await webhook.handler(
        commented(github, "issue_comment", {
          at: "2026-07-02T11:00:00Z",
          login: "Requester",
        }),
      );
      expect(calls).toEqual([reviewItem("GitHub asks you to review #946.")]);

      // A comment-only review neither approves nor requests changes. GitHub
      // drops the request on it, and Junior acts next, so the item closes
      // and the pull request is not ready to merge.
      github.requestedReviewers = [];
      github.reviews.push({
        body: "Why this name?",
        id: 501,
        state: "COMMENTED",
        submitted_at: "2026-07-02T12:00:00Z",
        user: { login: "Requester" },
      });
      await webhook.handler(
        reviewSubmitted("commented", {
          at: "2026-07-02T12:00:00Z",
          login: "Requester",
        }),
      );
      expect(calls.slice(1)).toEqual([ended]);

      // Junior answers and marks it. The review-again flow asks on GitHub,
      // and GitHub's request shows the item again.
      await markFeedback(
        state,
        { id: 501, kind: "review_body" },
        "addressed",
        fixture,
      );
      expect(asks()).toEqual(["request Requester"]);
      await webhook.handler(
        reviewRequested(github, "Requester", "2026-07-02T13:00:00Z"),
      );
      expect(calls.slice(2)).toEqual([
        reviewItem("Every comment on your review is handled."),
      ]);

      // The requester replies in the review thread instead of reviewing.
      // GitHub records it as a comment-only review, so Junior acts next.
      github.requestedReviewers = [];
      await webhook.handler(
        commented(github, "pull_request_review_comment", {
          at: "2026-07-02T14:00:00Z",
          login: "Requester",
        }),
      );
      expect(calls.slice(3)).toEqual([ended]);
      const reply = github.reviews.at(-1)?.id ?? 0;
      await markFeedback(
        state,
        { id: reply, kind: "review" },
        "addressed",
        fixture,
      );
      expect(asks()).toEqual(["request Requester", "request Requester"]);

      // An approval answers the ask, so the pull request is ready to merge.
      github.requestedReviewers = [];
      github.reviews.push({
        state: "APPROVED",
        submitted_at: "2026-07-02T15:00:00Z",
        user: { login: "Requester" },
      });
      await webhook.handler(
        reviewSubmitted("approved", {
          at: "2026-07-02T15:00:00Z",
          login: "Requester",
        }),
      );
      expect(calls.at(-1)).toMatchObject({
        kind: "upsert",
        notice: { title: "Ready to merge · #946" },
      });
    } finally {
      await fixture.close();
    }
  });

  it("keeps an approved pull request ready to merge after the requester's comment-only review", async () => {
    const fixture = await createGitHubFixture();
    const calls: InboxItemCall[] = [];
    const requests: string[] = [];
    const state = memoryState();
    const github: GitHubState = {
      draft: false,
      mergeableStates: ["clean"],
      merged: false,
      requestedReviewers: [],
      reviewRequests: [{ at: "2026-07-02T09:00:00Z", login: "Requester" }],
      reviews: [
        {
          state: "APPROVED",
          submitted_at: "2026-07-02T10:00:00Z",
          user: { login: "Requester" },
        },
      ],
      state: "open",
    };
    mockGitHub(github, requests);
    try {
      await seedJuniorPullRequest(fixture, "slack:C123:1712345.0001");
      const webhook = route(fixture, calls, [], { close: 0 }, [], state);
      await webhook.handler(
        reviewSubmitted("approved", {
          at: "2026-07-02T10:00:00Z",
          login: "Requester",
        }),
      );
      expect(calls).toMatchObject([
        { kind: "upsert", notice: { title: "Ready to merge · #946" } },
      ]);

      // A comment after the approval, with no ask since, leaves the
      // approval in place. Junior still answers it, but does not ask again.
      github.reviews.push({
        body: "Nit: rename this later.",
        id: 601,
        state: "COMMENTED",
        submitted_at: "2026-07-02T11:00:00Z",
        user: { login: "Requester" },
      });
      await webhook.handler(
        reviewSubmitted("commented", {
          at: "2026-07-02T11:00:00Z",
          login: "Requester",
        }),
      );
      await markFeedback(
        state,
        { id: 601, kind: "review_body" },
        "addressed",
        fixture,
      );
      expect(
        requests.filter((request) => request.startsWith("request")),
      ).toEqual([]);
      expect(calls).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("asks again on a held draft after the requester's comment-only review once Junior answers and the checks pass", async () => {
    const fixture = await createGitHubFixture();
    const calls: InboxItemCall[] = [];
    const requests: string[] = [];
    const state = memoryState();
    const github: GitHubState = {
      checks: [{ conclusion: null, name: "test", status: "QUEUED" }],
      draft: true,
      mergeableStates: ["draft"],
      merged: false,
      requestedReviewers: [],
      requiredChecks: ["test"],
      reviewRequests: [{ at: "2026-07-02T09:00:00Z", login: "Requester" }],
      reviews: [
        {
          body: "Why this name?",
          id: 701,
          state: "COMMENTED",
          submitted_at: "2026-07-02T10:00:00Z",
          user: { login: "Requester" },
        },
      ],
      state: "open",
    };
    mockGitHub(github, requests);
    try {
      await seedJuniorPullRequest(fixture, "slack:C123:1712345.0001");
      const webhook = route(fixture, calls, [], { close: 0 }, [], state);
      // Junior answers, but the checks still run, so the ask waits.
      await markFeedback(
        state,
        { id: 701, kind: "review_body" },
        "addressed",
        fixture,
      );
      expect(requests).not.toContain("request Requester");

      github.checks = [
        { conclusion: "SUCCESS", name: "test", status: "COMPLETED" },
      ];
      await webhook.handler(checkSuiteCompleted());
      expect(requests).toContain("request Requester");
      await webhook.handler(
        reviewRequested(github, "Requester", "2026-07-02T12:00:00Z"),
      );
      expect(calls.at(-1)).toMatchObject({
        kind: "upsert",
        notice: { title: "Review requested · #946" },
      });
    } finally {
      await fixture.close();
    }
  });

  it("asks again after a long discussion of more comment-only reviews than GitHub returns", async () => {
    const fixture = await createGitHubFixture();
    const calls: InboxItemCall[] = [];
    const requests: string[] = [];
    const state = memoryState();
    // 25 thread replies, more than the 20 reviews that the read returns.
    const ids = Array.from({ length: 25 }, (_, index) => 801 + index);
    const github: GitHubState = {
      draft: false,
      mergeableStates: ["blocked"],
      merged: false,
      requestedReviewers: [],
      reviewRequests: [{ at: "2026-07-02T09:00:00Z", login: "Requester" }],
      reviews: ids.map((id, index) => ({
        body: "",
        comments: [id],
        id,
        state: "COMMENTED",
        submitted_at: new Date(
          Date.parse("2026-07-02T10:00:00Z") + index * 60_000,
        ).toISOString(),
        user: { login: "Requester" },
      })),
      state: "open",
    };
    mockGitHub(github, requests);
    try {
      await seedJuniorPullRequest(fixture, "slack:C123:1712345.0001");
      route(fixture, calls, [], { close: 0 }, [], state);
      for (const id of ids) {
        await markFeedback(state, { id, kind: "review" }, "addressed", fixture);
      }
      expect(
        requests.filter((request) => request.startsWith("request")),
      ).toEqual(["request Requester"]);
    } finally {
      await fixture.close();
    }
  });

  it("says so when Junior answers the requester's comment-only review with a question", async () => {
    const fixture = await createGitHubFixture();
    const calls: InboxItemCall[] = [];
    const requests: string[] = [];
    const state = memoryState();
    const github: GitHubState = {
      draft: false,
      mergeableStates: ["clean"],
      merged: false,
      requestedReviewers: ["Requester"],
      reviewRequests: [{ at: "2026-07-02T10:00:00Z", login: "Requester" }],
      reviews: [],
      state: "open",
    };
    mockGitHub(github, requests);
    try {
      await seedJuniorPullRequest(fixture, "slack:C123:1712345.0001");
      const webhook = route(fixture, calls, [], { close: 0 }, [], state);
      await webhook.handler(pullRequestAction("synchronize"));
      expect(calls).toMatchObject([
        { kind: "upsert", notice: { title: "Review requested · #946" } },
      ]);

      // A reply in a review thread is a comment-only review. GitHub drops
      // the request on it, and Junior acts next, so the item closes.
      github.requestedReviewers = [];
      await webhook.handler(
        commented(github, "pull_request_review_comment", {
          at: "2026-07-02T12:00:00Z",
          login: "Requester",
        }),
      );
      expect(calls.at(-1)).toMatchObject({ kind: "close" });

      // Junior answers with a question, and `github_commentOnPullRequest`
      // marks why before GitHub asks for the review. The item comes back
      // and says that Junior asked.
      await markGitHubReviewAsked(
        state,
        { number: 946, repositoryFullName: "getsentry/junior" },
        {
          at: "2026-07-02T12:30:00.000Z",
          reason: "question",
          reviewer: "Requester",
        },
      );
      await webhook.handler(
        reviewRequested(github, "Requester", "2026-07-02T12:30:01Z"),
      );
      github.requestedReviewers = ["Requester"];
      await webhook.handler(pullRequestAction("synchronize"));
      expect(calls.at(-1)).toMatchObject({
        kind: "upsert",
        notice: {
          body: `A comment asks you a question.\n\n${PULL_URL}`,
          title: "Review requested · #946",
        },
      });
      expect(
        requests.filter((request) => request.startsWith("request")),
      ).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});
