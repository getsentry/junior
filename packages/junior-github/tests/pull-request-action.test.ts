import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitHubFixture } from "./github-db";
import { mswServer } from "./msw";
import {
  DEDUPE_KEY,
  PULL_URL,
  checkSuiteCompleted,
  mockGitHub,
  pullRequestAction,
  reviewSubmitted,
  route,
  seedJuniorPullRequest,
  stubGitHubAppEnv,
  type GitHubState,
  type InboxItemCall,
} from "./pull-request-action-harness";

describe("next action item", () => {
  beforeEach(() => {
    stubGitHubAppEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("adds one notice for the requester while the pull request is ready, and closes it when that stops", async () => {
    const fixture = await createGitHubFixture();
    const calls: InboxItemCall[] = [];
    const errors: string[] = [];
    const failures = { close: 0 };
    const requests: string[] = [];
    const github: GitHubState = {
      draft: false,
      mergeableStates: ["clean"],
      merged: false,
      reviews: [],
      state: "open",
      title: "feat(inbox): Add the Inbox notice",
    };
    mockGitHub(github, requests);
    try {
      await seedJuniorPullRequest(fixture, "slack:C123:1712345.0001");
      const webhook = route(fixture, calls, errors, failures);

      // GitHub can merge it, but no one approved it yet.
      await webhook.handler(checkSuiteCompleted());
      expect(calls).toEqual([]);
      expect(requests).toEqual(["pull"]);

      // The change request is on the older page of reviews.
      github.reviews = [
        { state: "CHANGES_REQUESTED", user: { login: "reviewer" } },
        ...Array.from({ length: 100 }, () => ({
          state: "COMMENTED",
          user: { login: "reviewer" },
        })),
        { state: "APPROVED", user: { login: "Reviewer" } },
      ];
      await webhook.handler(reviewSubmitted("approved"));
      const notice = {
        conversationId: "slack:C123:1712345.0001",
        kind: "upsert",
        notice: {
          assigneeIdentityIds: ["identity-requester"],
          body: `#946 is approved, and GitHub says that it can merge.\n\n${PULL_URL}`,
          dedupeKey: DEDUPE_KEY,
          subject: {
            id: PULL_URL,
            title: "feat(inbox): Add the Inbox notice (#946)",
            // The Inbox shows the parsed conventional commit title.
            titleParts: {
              scope: "inbox",
              text: "Add the Inbox notice",
              type: "Feature",
            },
            url: PULL_URL,
          },
          title: "Ready to merge · #946",
          // The merge is the requester's step, so the item waits on them.
          waitsOnAssignees: true,
        },
      };
      expect(calls).toEqual([notice]);

      // Repeat events while it stays ready add nothing.
      await webhook.handler(checkSuiteCompleted());
      await webhook.handler(reviewSubmitted("approved"));
      expect(calls).toEqual([notice]);

      // GitHub has not computed the merge state after a push. Two reads
      // stay unknown, so nothing changes, and a later event decides. The
      // older page of reviews still loads, for a change request by the
      // requester.
      requests.length = 0;
      github.mergeableStates = [null, "unknown"];
      await webhook.handler(pullRequestAction("synchronize"));
      expect(requests).toEqual(["pull", "pull", "reviews"]);
      expect(calls).toEqual([notice]);

      // The second read has the merge state: the new checks still run.
      github.mergeableStates = ["unknown", "blocked"];
      await webhook.handler(checkSuiteCompleted());
      expect(calls.at(-1)).toEqual({
        conversationId: "slack:C123:1712345.0001",
        input: {
          dedupeKey: DEDUPE_KEY,
          reason: "The pull request is no longer ready to merge.",
          status: "dismissed",
        },
        kind: "close",
      });

      // Two webhooks run at the same time. The first reads "clean", but its
      // read is slow. The second reads "blocked". The second waits for the
      // first, so the notice ends closed, as GitHub's latest state says.
      let release!: () => void;
      github.holdNextPullRead = new Promise((resolve) => {
        release = resolve;
      });
      github.mergeableStates = ["clean", "blocked"];
      const slow = webhook.handler(checkSuiteCompleted());
      const fast = webhook.handler(checkSuiteCompleted());
      await new Promise((resolve) => setTimeout(resolve, 100));
      release();
      await Promise.all([slow, fast]);
      expect(calls.slice(-2).map((call) => call.kind)).toEqual([
        "upsert",
        "close",
      ]);

      github.mergeableStates = ["clean"];
      await webhook.handler(checkSuiteCompleted());
      expect(calls.at(-1)).toEqual(notice);

      // With auto-merge on, GitHub merges it, so the notice closes. Turning
      // auto-merge off brings the notice back.
      github.autoMerge = true;
      await webhook.handler(pullRequestAction("auto_merge_enabled"));
      expect(calls.at(-1)).toEqual({
        conversationId: "slack:C123:1712345.0001",
        input: {
          dedupeKey: DEDUPE_KEY,
          reason: "Auto-merge is on.",
          status: "dismissed",
        },
        kind: "close",
      });
      github.autoMerge = false;
      await webhook.handler(pullRequestAction("auto_merge_disabled"));
      expect(calls.at(-1)).toEqual(notice);

      github.merged = true;
      github.state = "closed";
      // Each merge delivery closes the notice before its check, and both
      // closes fail. The check's close fails too. A webhook that arrives
      // during the failed check is not lost: the check runs again and
      // closes the notice.
      failures.close = 3;
      let releaseMerge!: () => void;
      github.holdNextPullRead = new Promise((resolve) => {
        releaseMerge = resolve;
      });
      const failing = webhook.handler(pullRequestAction("closed", true));
      const queued = webhook.handler(pullRequestAction("closed", true));
      await new Promise((resolve) => setTimeout(resolve, 100));
      releaseMerge();
      await Promise.all([failing, queued]);
      expect(errors).toEqual([
        "GitHub ended pull request item close failed",
        "GitHub ended pull request item close failed",
        "GitHub pull request action failed",
      ]);
      expect(calls.at(-1)).toEqual({
        conversationId: "slack:C123:1712345.0001",
        input: {
          dedupeKey: DEDUPE_KEY,
          reason: "The pull request merged.",
          status: "done",
        },
        kind: "close",
      });
      expect(calls.map((call) => call.kind)).toEqual([
        "upsert",
        "close",
        "upsert",
        "close",
        "upsert",
        "close",
        "upsert",
        "close",
      ]);
      expect(errors).toHaveLength(3);
    } finally {
      await fixture.close();
    }
  });

  it("closes the merge conflict notice when the conflict is gone", async () => {
    const fixture = await createGitHubFixture();
    const github: GitHubState = {
      draft: false,
      mergeableStates: ["dirty"],
      merged: false,
      requestedReviewers: [],
      reviews: [],
      state: "open",
    };
    mockGitHub(github, []);
    try {
      await seedJuniorPullRequest(fixture, "slack:C123:1712345.0001");
      const closes: string[] = [];
      const webhook = route(fixture, [], [], { close: 0 }, closes);
      const conflictCloses = () =>
        closes.filter((key) => key.startsWith("merge-conflict:"));
      await webhook.handler(checkSuiteCompleted());
      expect(conflictCloses()).toEqual([]);

      github.mergeableStates = ["blocked"];
      await webhook.handler(checkSuiteCompleted());
      expect(conflictCloses()).toEqual(["merge-conflict:getsentry/junior#946"]);
    } finally {
      await fixture.close();
    }
  });

  it("shows one item that changes from review to merge", async () => {
    const fixture = await createGitHubFixture();
    const calls: InboxItemCall[] = [];
    const github: GitHubState = {
      draft: false,
      mergeableStates: ["blocked"],
      merged: false,
      // Requests for other people or for a team do not wait on the requester.
      requestedReviewers: ["someone-else"],
      reviews: [],
      state: "open",
    };
    mockGitHub(github, []);
    try {
      await seedJuniorPullRequest(fixture, "slack:C123:1712345.0001");
      const otherCloses: string[] = [];
      const webhook = route(fixture, calls, [], { close: 0 }, otherCloses);
      await webhook.handler(pullRequestAction("review_requested"));
      expect(calls).toEqual([]);
      // Each check closes the items from before one item per pull request,
      // and the merge conflict notice of a pull request with no conflict.
      expect(otherCloses).toEqual([
        "pull-request-ready:getsentry/junior#946",
        "pull-request-review-requested:getsentry/junior#946",
        "merge-conflict:getsentry/junior#946",
      ]);

      // The GitHub login matches the requester's linked account in any case.
      // A new pull request often has no merge state yet, and the review ask
      // does not wait for it.
      github.requestedReviewers = ["requester"];
      github.mergeableStates = [null];
      await webhook.handler(pullRequestAction("review_requested"));
      const review = {
        conversationId: "slack:C123:1712345.0001",
        kind: "upsert",
        notice: {
          assigneeIdentityIds: ["identity-requester"],
          body: `GitHub asks you to review #946.\n\n${PULL_URL}`,
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
      expect(calls).toEqual([review]);

      github.requestedReviewers = [];
      github.mergeableStates = ["blocked"];
      await webhook.handler(pullRequestAction("review_request_removed"));
      expect(calls.at(-1)).toEqual({
        conversationId: "slack:C123:1712345.0001",
        input: {
          dedupeKey: DEDUPE_KEY,
          reason: "The review request ended.",
          status: "done",
        },
        kind: "close",
      });

      // GitHub does not send a new request on reopen. The reopen reads the
      // reviewers that are still requested.
      github.requestedReviewers = ["Requester"];
      await webhook.handler(pullRequestAction("reopened"));
      expect(calls.at(-1)).toEqual(review);

      // Someone else approves, and GitHub can merge it. The requester merges
      // or reviews, not both, so the same item now asks for the merge.
      github.mergeableStates = ["clean"];
      github.reviews = [{ state: "APPROVED", user: { login: "someone-else" } }];
      await webhook.handler(reviewSubmitted("approved"));
      expect(calls.at(-1)).toMatchObject({
        kind: "upsert",
        notice: { dedupeKey: DEDUPE_KEY, title: "Ready to merge · #946" },
      });
      expect(calls).toHaveLength(4);
    } finally {
      await fixture.close();
    }
  });

  it("reuses one installation token for later webhooks", async () => {
    const fixture = await createGitHubFixture();
    const requests: string[] = [];
    mockGitHub(
      {
        draft: false,
        mergeableStates: ["clean"],
        merged: false,
        reviews: [],
        state: "open",
      },
      requests,
    );
    let minted = 0;
    mswServer.use(
      http.post(
        "https://api.github.com/app/installations/456/access_tokens",
        () => {
          minted += 1;
          return HttpResponse.json({
            expires_at: "2027-01-01T00:00:00.000Z",
            token: "installation-token",
          });
        },
      ),
    );
    try {
      await seedJuniorPullRequest(fixture, "slack:C123:1712345.0001");
      const webhook = route(fixture, []);
      await webhook.handler(checkSuiteCompleted());
      await webhook.handler(reviewSubmitted("approved"));
      expect(requests).toEqual(["pull", "pull"]);
      expect(minted).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  it("reads nothing from GitHub for a pull request with no requester Conversation", async () => {
    const fixture = await createGitHubFixture();
    const calls: InboxItemCall[] = [];
    const requests: string[] = [];
    mockGitHub(
      {
        draft: false,
        mergeableStates: ["clean"],
        merged: false,
        reviews: [{ state: "APPROVED", user: { login: "reviewer" } }],
        state: "open",
      },
      requests,
    );
    try {
      await seedJuniorPullRequest(fixture, null);
      await route(fixture, calls).handler(reviewSubmitted("approved"));
      expect(requests).toEqual([]);
      expect(calls).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});
