import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GITHUB_PULL_REQUEST_ACTION_BACKFILL_TASK } from "../src/pull-request-action-backfill";
import {
  claimGitHubPullRequestReadySync,
  releaseGitHubPullRequestReadySync,
} from "../src/pull-request-outcomes/store";
import { juniorGitHubPullRequestRequesters } from "../src/db/schema";
import { createGitHubFixture } from "./github-db";
import { createPluginHarness, subjectKey } from "./plugin-harness";
import {
  SUBJECT,
  mockGitHub,
  requesterUsers,
  seedJuniorPullRequest,
  stubGitHubAppEnv,
} from "./pull-request-action-harness";

describe("next action backfill", () => {
  beforeEach(() => {
    stubGitHubAppEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("backfills the next action of quiet pull requests once, one page at a time", async () => {
    const fixture = await createGitHubFixture();
    const requests: string[] = [];
    // GitHub asked the requester before the derivation shipped, and no
    // webhook came since.
    mockGitHub(
      {
        draft: false,
        mergeableStates: ["blocked"],
        merged: false,
        requestedReviewers: ["Requester"],
        reviews: [],
        state: "open",
      },
      requests,
    );
    try {
      await seedJuniorPullRequest(fixture, "slack:C123:1712345.0001");
      // A full first page of pull requests that no person asked for. They
      // need no GitHub read.
      for (let number = 1; number <= 50; number += 1) {
        fixture.codeIndex.seed({
          conversationIds: [],
          number,
          openedAt: new Date("2026-07-01T12:00:00.000Z"),
          providerId: String(number),
          repository: { name: "getsentry/junior", providerId: "2001" },
          state: "open",
          updatedAt: new Date("2026-07-01T12:00:00.000Z"),
        });
      }
      const h = createPluginHarness(fixture, requesterUsers);
      const backfills = () =>
        h.startedTasks.filter(
          (task) => task.name === GITHUB_PULL_REQUEST_ACTION_BACKFILL_TASK,
        );
      const now = Date.parse("2026-07-03T12:00:00.000Z");

      await h.heartbeat(now);
      expect(backfills()).toHaveLength(1);
      await h.runStartedTasks();
      expect(requests).toEqual([]);
      expect(h.notices).toEqual([]);

      await h.heartbeat(now + 60_000);
      await h.runStartedTasks();
      expect(h.notices).toEqual([
        {
          conversationId: "slack:C123:1712345.0001",
          notice: expect.objectContaining({
            subject: SUBJECT,
            title: "Review requested · #946",
          }),
        },
      ]);

      // The last page is done, so a dismissed item stays closed.
      h.dismiss(subjectKey(SUBJECT));
      await h.heartbeat(now + 120_000);
      expect(backfills()).toEqual([]);
      // The reconcile and the name repair read GitHub APIs that this test
      // does not mock.
      expect(
        h.heartbeatLogs.filter(([, message]) =>
          message.includes("pull request action"),
        ),
      ).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("backfills a page again when a webhook was checking one of its pull requests", async () => {
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
    try {
      await seedJuniorPullRequest(fixture, "slack:C123:1712345.0001");
      // A webhook checks the pull request while the backfill runs. It checks
      // again for the backfill's request, but does not ask in limbo.
      const claim = await claimGitHubPullRequestReadySync(
        fixture.db(),
        "1001",
        { now: new Date(), staleMs: 60_000 },
      );
      if (!claim || claim === "held") {
        throw new Error("expected the webhook's claim");
      }
      const h = createPluginHarness(fixture, requesterUsers);
      const now = Date.parse("2026-07-03T12:00:00.000Z");
      await h.heartbeat(now);
      await h.runStartedTasks();
      expect(requests).toEqual([]);
      let held: number | undefined = claim.requests;
      while (held !== undefined) {
        held = await releaseGitHubPullRequestReadySync(fixture.db(), "1001", {
          id: claim.id,
          requests: held,
        });
      }

      // The next heartbeat runs the page again, and it asks.
      await h.heartbeat(now + 60_000);
      await h.runStartedTasks();
      expect(
        requests.filter((request) => request.startsWith("request")),
      ).toEqual(["request Requester"]);
      expect(h.notices.map(({ notice }) => notice.title)).toEqual([
        "Review requested · #946",
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("finishes the backfill past a pull request that Junior does not track", async () => {
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
    try {
      // The code index and the requester know the pull request, but Junior
      // has no row for it, so no webhook can hold its check.
      const at = new Date("2026-07-01T12:00:00.000Z");
      fixture.codeIndex.seed({
        conversationIds: ["slack:C123:1712345.0001"],
        number: 946,
        openedAt: at,
        providerId: "1001",
        repository: { name: "getsentry/junior", providerId: "2001" },
        state: "open",
        updatedAt: at,
      });
      await fixture.db().insert(juniorGitHubPullRequestRequesters).values({
        conversationId: "slack:C123:1712345.0001",
        createdAt: at,
        identityId: "identity-requester",
        number: 946,
        repositoryFullName: "getsentry/junior",
        updatedAt: at,
      });
      const h = createPluginHarness(fixture, requesterUsers);
      const backfills = () =>
        h.startedTasks.filter(
          (task) => task.name === GITHUB_PULL_REQUEST_ACTION_BACKFILL_TASK,
        );
      const now = Date.parse("2026-07-03T12:00:00.000Z");
      await h.heartbeat(now);
      await h.runStartedTasks();
      await h.heartbeat(now + 60_000);
      expect(backfills()).toEqual([]);
      expect(requests).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});
