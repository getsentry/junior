import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitHubFixture } from "./github-db";
import {
  SUBJECT,
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

// A pull request above another open pull request merges after it, though
// GitHub's merge state checks it only against its base branch.
describe("merge ask above an open base", () => {
  beforeEach(() => {
    stubGitHubAppEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("closes a merge ask once the pull request below it opens", async () => {
    const fixture = await createGitHubFixture();
    const calls: InboxItemCall[] = [];
    const github: GitHubState = {
      baseRefName: "feat/base",
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
    mockGitHub(github, []);
    try {
      await seedJuniorPullRequest(fixture, "slack:C123:1712345.0001");
      const webhook = route(fixture, calls);
      await webhook.handler(checkSuiteCompleted());
      expect(calls).toMatchObject([
        { kind: "upsert", notice: { title: "Ready to merge · #946" } },
      ]);

      github.openPullRequestHeads = ["feat/base"];
      await webhook.handler(checkSuiteCompleted());
      expect(calls.slice(1)).toEqual([
        {
          conversationId: "slack:C123:1712345.0001",
          input: {
            subject: SUBJECT,
            reason: "It merges after the pull request below it.",
            status: "dismissed",
          },
          kind: "close",
        },
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("asks to merge only once the base merges and GitHub retargets the pull request", async () => {
    const fixture = await createGitHubFixture();
    const calls: InboxItemCall[] = [];
    const requests: string[] = [];
    const github: GitHubState = {
      baseRefName: "feat/base",
      draft: false,
      mergeableStates: ["clean"],
      merged: false,
      openPullRequestHeads: ["feat/base"],
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
      const webhook = route(fixture, calls);
      await webhook.handler(checkSuiteCompleted());
      expect(calls).toEqual([]);

      // An edit that keeps the base reads nothing.
      requests.length = 0;
      await webhook.handler(
        pullRequestAction("edited", false, undefined, {
          title: { from: "Old title" },
        }),
      );
      expect(requests).not.toContain("pull");

      // The base merged, and GitHub moved the pull request onto main.
      github.baseRefName = "main";
      github.openPullRequestHeads = [];
      await webhook.handler(
        pullRequestAction("edited", false, undefined, {
          base: { ref: { from: "feat/base" }, sha: { from: "base-1" } },
        }),
      );
      expect(calls).toMatchObject([
        { kind: "upsert", notice: { title: "Ready to merge · #946" } },
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("asks to merge into the default branch when an open pull request syncs it elsewhere", async () => {
    const fixture = await createGitHubFixture();
    const calls: InboxItemCall[] = [];
    mockGitHub(
      {
        draft: false,
        mergeableStates: ["clean"],
        merged: false,
        // A pull request from main into a long-lived branch.
        openPullRequestHeads: ["main"],
        reviews: [
          {
            state: "APPROVED",
            submitted_at: "2026-07-02T12:00:00.000Z",
            user: { login: "Requester" },
          },
        ],
        state: "open",
      },
      [],
    );
    try {
      await seedJuniorPullRequest(fixture, "slack:C123:1712345.0001");
      await route(fixture, calls).handler(checkSuiteCompleted());
      expect(calls).toMatchObject([
        { kind: "upsert", notice: { title: "Ready to merge · #946" } },
      ]);
    } finally {
      await fixture.close();
    }
  });
});

// GitHub merges a pull request in the merge queue, so no person needs to.
describe("merge ask in the merge queue", () => {
  beforeEach(() => {
    stubGitHubAppEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("closes the merge ask while the pull request is queued, and asks again when it leaves the queue", async () => {
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
      const webhook = route(fixture, calls);
      await webhook.handler(checkSuiteCompleted());
      expect(calls).toMatchObject([
        { kind: "upsert", notice: { title: "Ready to merge · #946" } },
      ]);

      github.inMergeQueue = true;
      await webhook.handler(pullRequestAction("enqueued"));
      expect(calls.slice(1)).toEqual([
        {
          conversationId: "slack:C123:1712345.0001",
          input: {
            subject: SUBJECT,
            reason: "It is in the merge queue.",
            status: "done",
          },
          kind: "close",
        },
      ]);

      // A failed merge group takes it out of the queue.
      github.inMergeQueue = false;
      await webhook.handler(pullRequestAction("dequeued"));
      expect(calls.slice(2)).toMatchObject([
        { kind: "upsert", notice: { title: "Ready to merge · #946" } },
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("does not ask for the requester's review of a queued pull request", async () => {
    const fixture = await createGitHubFixture();
    const calls: InboxItemCall[] = [];
    const requests: string[] = [];
    // The repo requires no review, so a person queued it unreviewed.
    mockGitHub(
      {
        draft: false,
        inMergeQueue: true,
        mergeableStates: ["clean"],
        merged: false,
        reviews: [],
        state: "open",
      },
      requests,
    );
    try {
      await seedJuniorPullRequest(fixture, "slack:C123:1712345.0001");
      await route(fixture, calls).handler(checkSuiteCompleted());
      expect(requests).not.toContain("request Requester");
      expect(calls).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});
