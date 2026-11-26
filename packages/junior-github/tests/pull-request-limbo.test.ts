import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitHubFixture } from "./github-db";
import { createPluginHarness } from "./plugin-harness";
import {
  checkSuiteCompleted,
  mockGitHub,
  pullRequestAction,
  requesterUsers,
  route,
  seedJuniorPullRequest,
  stubGitHubAppEnv,
  type GitHubState,
  type InboxItemCall,
} from "./pull-request-action-harness";

// A ready Junior pull request that asks nothing of its requester is in
// limbo, and Junior asks for the requester's review on GitHub.
describe("limbo review ask", () => {
  beforeEach(() => {
    stubGitHubAppEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("asks the requester's review on a ready pull request that waits on nobody once the required checks pass", async () => {
    const fixture = await createGitHubFixture();
    const calls: InboxItemCall[] = [];
    const requests: string[] = [];
    // Junior opened it ready, but the requester linked GitHub only later,
    // so no one asked them.
    const github: GitHubState = {
      draft: false,
      mergeableStates: ["blocked"],
      merged: false,
      requiredChecks: ["test"],
      reviews: [],
      state: "open",
    };
    mockGitHub(github, requests);
    try {
      await seedJuniorPullRequest(fixture, "slack:C123:1712345.0001");
      const webhook = route(fixture, calls);
      await webhook.handler(checkSuiteCompleted());
      expect(requests).not.toContain("request Requester");
      expect(calls).toEqual([]);

      github.checks = [
        { conclusion: "SUCCESS", name: "test", status: "COMPLETED" },
      ];
      await webhook.handler(checkSuiteCompleted());
      expect(
        requests.filter((request) => request.startsWith("request")),
      ).toEqual(["request Requester"]);
      expect(calls).toMatchObject([
        { kind: "upsert", notice: { title: "Review requested · #946" } },
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("asks in limbo when the checks pass by the time a webhook during the sync checks again", async () => {
    const fixture = await createGitHubFixture();
    const calls: InboxItemCall[] = [];
    const requests: string[] = [];
    const github: GitHubState = {
      draft: false,
      mergeableStates: ["blocked"],
      merged: false,
      requiredChecks: ["test"],
      reviews: [],
      state: "open",
    };
    // The first read of the checks finds them pending. Later reads find
    // them passing.
    let checkReads = 0;
    Object.defineProperty(github, "checks", {
      get: () =>
        checkReads++ === 0
          ? []
          : [{ conclusion: "SUCCESS", name: "test", status: "COMPLETED" }],
    });
    mockGitHub(github, requests);
    try {
      await seedJuniorPullRequest(fixture, "slack:C123:1712345.0001");
      const webhook = route(fixture, calls);
      let release!: () => void;
      github.holdNextPullRead = new Promise((resolve) => {
        release = resolve;
      });
      const first = webhook.handler(pullRequestAction("review_requested"));
      const queued = webhook.handler(pullRequestAction("review_requested"));
      await new Promise((resolve) => setTimeout(resolve, 100));
      release();
      await Promise.all([first, queued]);
      expect(
        requests.filter((request) => request.startsWith("request")),
      ).toEqual(["request Requester"]);
      expect(calls).toMatchObject([
        { kind: "upsert", notice: { title: "Review requested · #946" } },
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("does not ask a requester again who removed their own review request", async () => {
    const fixture = await createGitHubFixture();
    const calls: InboxItemCall[] = [];
    const requests: string[] = [];
    mockGitHub(
      {
        draft: false,
        mergeableStates: ["blocked"],
        merged: false,
        reviewRequestRemovals: [
          {
            actor: "Requester",
            at: "2026-07-02T11:00:00Z",
            login: "Requester",
          },
        ],
        reviewRequests: [{ at: "2026-07-02T10:00:00Z", login: "Requester" }],
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

  const pushedAt = "2026-07-02T12:00:00.000Z";
  it.each<{
    asks: boolean;
    github: Partial<GitHubState>;
    item?: boolean;
    name: string;
  }>([
    { asks: true, github: {}, name: "waits on nobody" },
    {
      asks: true,
      github: {
        comments: [{ at: "2026-07-02T11:00:00.000Z", login: "Requester" }],
      },
      name: "the requester commented before the last push",
    },
    {
      asks: false,
      github: {
        comments: [{ at: "2026-07-02T13:00:00.000Z", login: "Requester" }],
      },
      name: "the requester commented after the last push, so Junior acts next",
    },
    {
      asks: false,
      github: {
        reviews: [{ state: "APPROVED", user: { login: "someone-else" } }],
      },
      name: "it is approved and waits on others",
    },
    {
      asks: false,
      github: {
        reviews: [
          { state: "CHANGES_REQUESTED", user: { login: "someone-else" } },
        ],
      },
      name: "a reviewer requests changes, so Junior acts next",
    },
    { asks: false, github: { autoMerge: true }, name: "auto-merge is on" },
    {
      asks: false,
      github: {
        reviewRequestRemovals: [
          {
            actor: "Requester",
            at: "2026-07-02T11:30:00.000Z",
            login: "Requester",
          },
        ],
        reviewRequests: [
          { at: "2026-07-02T11:00:00.000Z", login: "Requester" },
        ],
      },
      name: "the requester removed their own review request",
    },
    {
      asks: true,
      github: {
        reviewRequestRemovals: [
          {
            actor: "someone-else",
            at: "2026-07-02T11:30:00.000Z",
            login: "Requester",
          },
        ],
        reviewRequests: [
          { at: "2026-07-02T11:00:00.000Z", login: "Requester" },
        ],
      },
      name: "another person removed the requester's review request",
    },
    {
      asks: false,
      github: {
        reviews: [
          {
            state: "COMMENTED",
            submitted_at: "2026-07-02T13:00:00.000Z",
            user: { login: "Requester" },
          },
        ],
      },
      name: "the requester left a comment-only review, so Junior acts next",
    },
    {
      asks: false,
      github: {
        reviewRequests: [
          { at: "2026-07-02T11:00:00.000Z", login: "Requester" },
        ],
        reviews: [
          {
            state: "COMMENTED",
            submitted_at: "2026-07-02T13:00:00.000Z",
            user: { login: "Requester" },
          },
        ],
      },
      name: "a comment-only review answers no ask, but Junior acts next",
    },
    {
      asks: true,
      github: {
        reviews: [
          {
            state: "DISMISSED",
            submitted_at: "2026-07-02T10:00:00.000Z",
            user: { login: "Requester" },
          },
          {
            state: "COMMENTED",
            submitted_at: "2026-07-02T11:00:00.000Z",
            user: { login: "Requester" },
          },
        ],
      },
      name: "a push dismissed the requester's approval after their comment",
    },
  ])(
    "backfill asks the requester's review in limbo: $name",
    async ({ asks, github, item = asks }) => {
      const fixture = await createGitHubFixture();
      const requests: string[] = [];
      mockGitHub(
        {
          draft: false,
          headCommittedAt: pushedAt,
          mergeableStates: ["blocked"],
          merged: false,
          reviews: [],
          state: "open",
          ...github,
        },
        requests,
      );
      try {
        await seedJuniorPullRequest(fixture, "slack:C123:1712345.0001");
        const h = createPluginHarness(fixture, requesterUsers);
        await h.heartbeat(Date.parse("2026-07-03T12:00:00.000Z"));
        await h.runStartedTasks();
        // Only the requester, never a team or a code owner.
        expect(
          requests.filter((request) => request.startsWith("request")),
        ).toEqual(asks ? ["request Requester"] : []);
        expect(h.notices.map(({ notice }) => notice.title)).toEqual(
          item ? ["Review requested · #946"] : [],
        );
      } finally {
        await fixture.close();
      }
    },
  );
});
