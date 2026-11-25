import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitHubFixture } from "./github-db";
import { mswServer } from "./msw";
import {
  SUBJECT,
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
      mergeableStates: ["blocked"],
      merged: false,
      reviews: [],
      state: "open",
      title: "feat(inbox): Add the Inbox notice",
    };
    mockGitHub(github, requests);
    try {
      await seedJuniorPullRequest(fixture, "slack:C123:1712345.0001");
      const webhook = route(fixture, calls, errors, failures);

      // The repo requires a review, and no one approved it yet.
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
      github.mergeableStates = ["clean"];
      await webhook.handler(reviewSubmitted("approved"));
      const notice = {
        conversationId: "slack:C123:1712345.0001",
        kind: "upsert",
        notice: {
          // The approval gives the requester the merge ask, so it pushes.
          askedIdentityIds: ["identity-requester"],
          assigneeIdentityIds: ["identity-requester"],
          body: `#946 is approved, and GitHub says that it can merge.\n\n${PULL_URL}`,
          subject: SUBJECT,
          // The Inbox reads the title of the pull request from GitHub.
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
          subject: SUBJECT,
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
          subject: SUBJECT,
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
        "GitHub ended pull request change failed: Error",
        "GitHub ended pull request change failed: Error",
        "GitHub pull request action failed: Error",
      ]);
      expect(calls.at(-1)).toEqual({
        conversationId: "slack:C123:1712345.0001",
        input: {
          subject: SUBJECT,
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

  it("asks the requester to review and merge a pull request that GitHub can merge with no review", async () => {
    const fixture = await createGitHubFixture();
    const calls: InboxItemCall[] = [];
    const github: GitHubState = {
      draft: false,
      mergeableStates: ["clean"],
      merged: false,
      reviews: [],
      state: "open",
    };
    mockGitHub(github, []);
    try {
      await seedJuniorPullRequest(fixture, "slack:C123:1712345.0001");
      const webhook = route(fixture, calls);

      // The repo requires no review, so GitHub says that it can merge. A
      // pending review request still comes first. A request for someone
      // else or for a team waits on them, so no item asks the requester.
      github.requestedReviewers = ["someone-else"];
      await webhook.handler(pullRequestAction("review_requested"));
      github.requestedReviewers = [];
      github.requestedTeams = ["reviewers"];
      await webhook.handler(pullRequestAction("review_requested"));
      expect(calls).toEqual([]);

      // A request for the requester asks for their review.
      github.requestedTeams = [];
      github.requestedReviewers = ["requester"];
      await webhook.handler(pullRequestAction("review_requested"));
      expect(calls).toMatchObject([
        { kind: "upsert", notice: { title: "Review requested · #946" } },
      ]);

      // With no request left, the same item asks to review and merge.
      github.requestedReviewers = [];
      await webhook.handler(pullRequestAction("review_request_removed"));
      expect(calls.slice(1)).toMatchObject([
        {
          kind: "upsert",
          notice: {
            body: `GitHub says that #946 can merge with no review. Review it, then merge it.\n\n${PULL_URL}`,
            subject: SUBJECT,
            title: "Ready to merge · #946",
            waitsOnAssignees: true,
          },
        },
      ]);

      // The approval keeps the same action. The item shows each check's
      // read, so its text now says that the pull request is approved, and
      // it asks nobody again.
      github.reviews = [{ state: "APPROVED", user: { login: "requester" } }];
      await webhook.handler(
        reviewSubmitted("approved", { login: "requester" }),
      );
      expect(calls.slice(2)).toMatchObject([
        {
          kind: "upsert",
          notice: {
            askedIdentityIds: [],
            body: `#946 is approved, and GitHub says that it can merge.\n\n${PULL_URL}`,
            title: "Ready to merge · #946",
          },
        },
      ]);

      // A change request by any reviewer ends the merge.
      github.reviews.push({
        state: "CHANGES_REQUESTED",
        user: { login: "someone-else" },
      });
      await webhook.handler(reviewSubmitted("changes_requested"));
      expect(calls.at(-1)).toEqual({
        conversationId: "slack:C123:1712345.0001",
        input: {
          subject: SUBJECT,
          reason: "The pull request is no longer ready to merge.",
          status: "dismissed",
        },
        kind: "close",
      });
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
        closes.filter((key) => key.startsWith("merge_conflict:"));
      await webhook.handler(checkSuiteCompleted());
      expect(conflictCloses()).toEqual([]);

      github.mergeableStates = ["blocked"];
      await webhook.handler(checkSuiteCompleted());
      expect(conflictCloses()).toEqual(["merge_conflict:1001"]);
    } finally {
      await fixture.close();
    }
  });

  it("changes the same item from the review ask to the merge ask", async () => {
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
      // Each check closes the merge conflict notice of a pull request with
      // no conflict.
      expect(otherCloses).toEqual(["merge_conflict:1001"]);

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
          askedIdentityIds: ["identity-requester"],
          assigneeIdentityIds: ["identity-requester"],
          body: `GitHub asks you to review #946.\n\n${PULL_URL}`,
          subject: SUBJECT,
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
          subject: SUBJECT,
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

      // Someone else approves, and GitHub can merge it. GitHub still asks
      // the requester, so the item still asks for the review.
      github.mergeableStates = ["clean"];
      github.reviews = [{ state: "APPROVED", user: { login: "someone-else" } }];
      await webhook.handler(reviewSubmitted("approved"));
      expect(calls).toHaveLength(3);

      // The requester's review ends the request. The requester merges or
      // reviews, not both, so the same item now asks for the merge.
      github.requestedReviewers = [];
      github.reviews.push({ state: "COMMENTED", user: { login: "requester" } });
      await webhook.handler(
        reviewSubmitted("commented", { login: "requester" }),
      );
      expect(calls.at(-1)).toMatchObject({
        kind: "upsert",
        notice: {
          askedIdentityIds: ["identity-requester"],
          subject: SUBJECT,
          title: "Ready to merge · #946",
        },
      });
      expect(calls).toHaveLength(4);
    } finally {
      await fixture.close();
    }
  });

  it("keeps one item for every requested reviewer, pushes only the newly asked one, and drops a reviewer who reviews", async () => {
    const fixture = await createGitHubFixture();
    const calls: InboxItemCall[] = [];
    const github: GitHubState = {
      draft: false,
      mergeableStates: ["blocked"],
      merged: false,
      requestedReviewers: ["Alice"],
      reviews: [],
      state: "open",
    };
    mockGitHub(github, []);
    try {
      await seedJuniorPullRequest(fixture, "slack:C123:1712345.0001");
      const webhook = route(fixture, calls, [], { close: 0 }, [], undefined, {
        alice: "identity-alice",
        bob: "identity-bob",
      });
      const upsert = (asked: string[], assignees: string[]) => ({
        conversationId: "slack:C123:1712345.0001",
        kind: "upsert",
        notice: expect.objectContaining({
          askedIdentityIds: asked,
          assigneeIdentityIds: assignees,
          subject: SUBJECT,
          title: "Review requested · #946",
        }),
      });
      await webhook.handler(
        pullRequestAction("review_requested", false, "Alice"),
      );
      expect(calls).toEqual([upsert(["identity-alice"], ["identity-alice"])]);

      // A second request adds Bob to the same item and pushes only to him.
      github.requestedReviewers = ["Alice", "bob"];
      await webhook.handler(
        pullRequestAction("review_requested", false, "bob"),
      );
      expect(calls.at(-1)).toEqual(
        upsert(["identity-bob"], ["identity-alice", "identity-bob"]),
      );

      // Other events change nothing and push nobody.
      await webhook.handler(checkSuiteCompleted());
      expect(calls).toHaveLength(2);

      // Alice reviews, so GitHub no longer requests her review. She leaves
      // the item, and Bob stays on it with no new push.
      github.requestedReviewers = ["bob"];
      github.reviews = [{ state: "COMMENTED", user: { login: "Alice" } }];
      await webhook.handler(reviewSubmitted("commented", { login: "Alice" }));
      expect(calls.at(-1)).toEqual(upsert([], ["identity-bob"]));

      // Bob reviews too. Nobody has an ask, so the item closes.
      github.requestedReviewers = [];
      await webhook.handler(reviewSubmitted("approved", { login: "bob" }));
      expect(calls.at(-1)).toEqual({
        conversationId: "slack:C123:1712345.0001",
        input: {
          reason: "The review request ended.",
          status: "done",
          subject: SUBJECT,
        },
        kind: "close",
      });
    } finally {
      await fixture.close();
    }
  });

  it("asks both reviewers when their review requests arrive together", async () => {
    const fixture = await createGitHubFixture();
    const calls: InboxItemCall[] = [];
    const github: GitHubState = {
      draft: false,
      mergeableStates: ["blocked"],
      merged: false,
      requestedReviewers: ["Alice", "bob"],
      reviews: [],
      state: "open",
    };
    mockGitHub(github, []);
    try {
      await seedJuniorPullRequest(fixture, "slack:C123:1712345.0001");
      const webhook = route(fixture, calls, [], { close: 0 }, [], undefined, {
        alice: "identity-alice",
        bob: "identity-bob",
      });
      // GitHub sends one webhook per reviewer. Bob's arrives while Alice's
      // checks, so Alice's check asks him in its next read.
      let release!: () => void;
      github.holdNextPullRead = new Promise((resolve) => {
        release = resolve;
      });
      const first = webhook.handler(
        pullRequestAction("review_requested", false, "Alice"),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      const second = webhook.handler(
        pullRequestAction("review_requested", false, "bob"),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      release();
      await Promise.all([first, second]);
      const asked = calls.flatMap((call) =>
        call.kind === "upsert"
          ? (call.notice as { askedIdentityIds: string[] }).askedIdentityIds
          : [],
      );
      expect(asked.sort()).toEqual(["identity-alice", "identity-bob"]);
      expect(calls.at(-1)).toEqual({
        conversationId: "slack:C123:1712345.0001",
        kind: "upsert",
        notice: expect.objectContaining({
          assigneeIdentityIds: ["identity-alice", "identity-bob"],
        }),
      });
    } finally {
      await fixture.close();
    }
  });

  it("asks the requester to review a draft and mark it ready, then to review it", async () => {
    const fixture = await createGitHubFixture();
    const calls: InboxItemCall[] = [];
    const github: GitHubState = {
      draft: true,
      mergeableStates: ["draft"],
      merged: false,
      // Junior kept the draft for the requester and asked only them.
      requestedReviewers: ["requester"],
      reviews: [],
      state: "open",
    };
    mockGitHub(github, []);
    try {
      await seedJuniorPullRequest(fixture, "slack:C123:1712345.0001");
      const webhook = route(fixture, calls);
      const upsert = (body: string) => ({
        conversationId: "slack:C123:1712345.0001",
        kind: "upsert",
        notice: {
          askedIdentityIds: ["identity-requester"],
          assigneeIdentityIds: ["identity-requester"],
          body: `${body}\n\n${PULL_URL}`,
          subject: SUBJECT,
          title: "Review requested · #946",
          waitsOnAssignees: true,
        },
      });
      await webhook.handler(pullRequestAction("review_requested"));
      expect(calls).toEqual([
        upsert("#946 is a draft. Review it, then mark it ready for review."),
      ]);

      // The requester approves it, but it stays a draft, such as when the
      // repo's AGENTS.md leaves it for a person to mark ready. The same item
      // now gives the one step left.
      github.requestedReviewers = [];
      github.reviews = [{ state: "APPROVED", user: { login: "requester" } }];
      await webhook.handler(
        reviewSubmitted("approved", { login: "requester" }),
      );
      expect(calls.at(-1)).toEqual(
        upsert("You approved #946. Mark it ready for review."),
      );

      // GitHub asks them again before they mark it ready. Once it is
      // ready, the same item says only that GitHub asks for the review.
      github.requestedReviewers = ["requester"];
      github.reviews = [];
      github.draft = false;
      github.mergeableStates = ["blocked"];
      await webhook.handler(pullRequestAction("ready_for_review"));
      expect(calls.at(-1)).toEqual(upsert("GitHub asks you to review #946."));
      expect(calls).toHaveLength(3);
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
        mergeableStates: ["blocked"],
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

  it("logs the GraphQL error when GitHub returns errors with no data", async () => {
    const fixture = await createGitHubFixture();
    const calls: InboxItemCall[] = [];
    const errors: string[] = [];
    mockGitHub(
      {
        draft: false,
        mergeableStates: ["clean"],
        merged: false,
        reviews: [],
        state: "open",
      },
      [],
    );
    // GitHub reports GraphQL errors, such as a rate limit, with HTTP 200.
    mswServer.use(
      http.post("https://api.github.com/graphql", () =>
        HttpResponse.json({
          errors: [
            {
              message:
                "API rate limit already exceeded for installation ID 456.",
              type: "RATE_LIMITED",
            },
          ],
        }),
      ),
    );
    try {
      await seedJuniorPullRequest(fixture, "slack:C123:1712345.0001");
      await route(fixture, calls, errors).handler(checkSuiteCompleted());
      expect(errors).toEqual([
        "GitHub pull request action failed: GitHubGraphqlError",
      ]);
      expect(calls).toEqual([]);
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
