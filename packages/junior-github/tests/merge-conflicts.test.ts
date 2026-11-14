import { generateKeyPairSync } from "node:crypto";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  juniorGitHubPullRequestRequesters,
  juniorGitHubPullRequests,
} from "../src/db/schema";
import { createGitHubFixture, type GitHubFixture } from "./github-db";
import { mswServer } from "./msw";
import {
  createPluginHarness,
  signedRequest,
  type PluginHarness,
} from "./plugin-harness";

function pullRequestResponse(input: {
  headSha: string;
  mergeable: boolean | null;
  mergeableState: string;
}) {
  return {
    base: { ref: "main" },
    head: { ref: "feat/idle", sha: input.headSha },
    html_url: "https://github.com/getsentry/junior/pull/946",
    mergeable: input.mergeable,
    mergeable_state: input.mergeableState,
    state: "open",
  };
}

/** A signed conversation comment on pull request 946. */
function commentRequest(deliveryId: string): Request {
  return signedRequest({
    deliveryId,
    eventName: "issue_comment",
    body: {
      action: "created",
      installation: { id: 456 },
      repository: { full_name: "getsentry/junior" },
      issue: {
        number: 946,
        pull_request: {
          url: "https://api.github.com/repos/getsentry/junior/pulls/946",
        },
      },
      comment: { body: "Any update?", id: 4001, user: { login: "jane" } },
    },
  });
}

describe("merge conflict check on webhook events", () => {
  let fixture: GitHubFixture;
  let h: PluginHarness;
  let pullRequestReads: number;
  let pullRequest: ReturnType<typeof pullRequestResponse>;
  let reactions: number;

  const deliver = async (
    deliveryId: string,
    request: Request = commentRequest(deliveryId),
  ) => await h.deliver(request);
  const heartbeat = async (nowMs: number) => await h.heartbeat(nowMs);

  const conflicts = () =>
    h.published.filter(
      (event) => event.eventType === "pull_request.merge_conflict",
    );

  beforeEach(async () => {
    fixture = await createGitHubFixture();
    h = createPluginHarness(fixture);
    pullRequestReads = 0;
    reactions = 0;
    pullRequest = pullRequestResponse({
      headSha: "1111111111111111111111111111111111111111",
      mergeable: false,
      mergeableState: "dirty",
    });
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    vi.stubEnv("GITHUB_APP_ID", "123");
    vi.stubEnv("GITHUB_INSTALLATION_ID", "456");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", privateKey);
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "test-secret");
    mswServer.use(
      http.post(
        "https://api.github.com/app/installations/456/access_tokens",
        () =>
          HttpResponse.json({
            expires_at: "2027-01-01T00:00:00.000Z",
            token: "installation-token",
          }),
      ),
      http.get(
        "https://api.github.com/repos/getsentry/junior/pulls/946",
        () => {
          pullRequestReads += 1;
          return HttpResponse.json(pullRequest);
        },
      ),
      http.post(
        "https://api.github.com/repos/getsentry/junior/issues/comments/4001/reactions",
        () => {
          reactions += 1;
          return HttpResponse.json({ id: 1 });
        },
      ),
      http.get(
        "https://api.github.com/repos/getsentry/junior/pulls/946/commits",
        () => HttpResponse.json([]),
      ),
    );
  });

  afterEach(async () => {
    await fixture.close();
    vi.unstubAllEnvs();
  });

  it("publishes a conflict found when another event arrives for a watched pull request", async () => {
    await deliver("delivery-1");

    expect(h.published.map((event) => event.eventType)).toEqual([
      "pull_request.comment.created",
      "pull_request.comment.created",
      "pull_request.merge_conflict",
      "pull_request.merge_conflict",
    ]);
    expect(conflicts()).toEqual([
      expect.objectContaining({
        eventKey:
          "github:merge-conflict:getsentry/junior#946:1111111111111111111111111111111111111111",
        identifier: "getsentry/junior#946",
        objectType: "code_change",
        trustedSummary:
          "GitHub PR getsentry/junior#946 has merge conflicts with main.",
        data: {
          baseBranch: "main",
          headSha: "1111111111111111111111111111111111111111",
          pullRequest: 946,
          repo: "getsentry/junior",
          url: "https://github.com/getsentry/junior/pull/946",
        },
      }),
      expect.objectContaining({ identifier: "getsentry/junior" }),
    ]);

    // The same head commit keeps its event key, so a Watch gets it once.
    // After Junior merges the base branch, a new conflict gets a new key.
    pullRequest = pullRequestResponse({
      headSha: "2222222222222222222222222222222222222222",
      mergeable: false,
      mergeableState: "dirty",
    });
    await deliver("delivery-2");
    expect(conflicts().map((event) => event.eventKey)).toEqual([
      expect.stringContaining(":1111111111111111111111111111111111111111"),
      expect.stringContaining(":1111111111111111111111111111111111111111"),
      expect.stringContaining(":2222222222222222222222222222222222222222"),
      expect.stringContaining(":2222222222222222222222222222222222222222"),
    ]);
  });

  it("publishes no conflict while GitHub calculates mergeability", async () => {
    pullRequest = pullRequestResponse({
      headSha: "1111111111111111111111111111111111111111",
      mergeable: null,
      mergeableState: "unknown",
    });
    await deliver("delivery-1");
    expect(pullRequestReads).toBe(1);
    expect(conflicts()).toEqual([]);
  });

  it("does not read the pull request when nothing wants conflicts", async () => {
    h.watches.conflicts = false;
    await deliver("delivery-1");
    expect(pullRequestReads).toBe(0);
    expect(conflicts()).toEqual([]);
  });

  it("does not mark a comment when only conflicts are watched", async () => {
    h.watches.comments = false;
    await deliver("delivery-1");
    expect(reactions).toBe(0);
    expect(conflicts()).toHaveLength(2);
  });

  it("uses the mergeability in a pull request webhook without reading the pull request", async () => {
    await deliver(
      "delivery-1",
      signedRequest({
        deliveryId: "delivery-1",
        eventName: "pull_request",
        body: {
          action: "ready_for_review",
          installation: { id: 456 },
          repository: { full_name: "getsentry/junior", id: 1 },
          pull_request: {
            ...pullRequestResponse({
              headSha: "3333333333333333333333333333333333333333",
              mergeable: false,
              mergeableState: "dirty",
            }),
            created_at: "2026-07-01T12:00:00.000Z",
            draft: false,
            id: 9460,
            merged: false,
            number: 946,
            updated_at: "2026-07-02T12:00:00.000Z",
            user: { login: "jane" },
          },
        },
      }),
    );
    expect(pullRequestReads).toBe(0);
    expect(conflicts().map((event) => event.eventKey)).toEqual([
      expect.stringContaining(":3333333333333333333333333333333333333333"),
      expect.stringContaining(":3333333333333333333333333333333333333333"),
    ]);
  });

  describe("after a push to the default branch", () => {
    const pushedAt = Date.parse("2026-11-09T12:00:00.000Z");
    const minute = 60_000;
    let searches: string[];
    let mergeability: Record<number, string>;
    let headSha: string;
    let drafts: Set<number>;
    let approvals: Set<number>;
    /** The timeline of 946 on GitHub. */
    let timeline: Array<{ __typename: string }>;
    const pushes = () =>
      timeline.filter((item) =>
        ["HeadRefForcePushedEvent", "PullRequestCommit"].includes(
          item.__typename,
        ),
      );
    const discussion = () =>
      timeline.filter((item) => !pushes().includes(item));
    let historyReads: number;
    let duringRead: (() => Promise<void>) | undefined;

    function pushRequest(ref: string, repo = "getsentry/junior"): Request {
      return signedRequest({
        deliveryId: `push-${repo}-${ref}`,
        eventName: "push",
        body: {
          installation: { id: 456 },
          ref,
          repository: { default_branch: "main", full_name: repo },
        },
      });
    }

    beforeEach(async () => {
      vi.useFakeTimers({ now: pushedAt, toFake: ["Date"] });
      searches = [];
      mergeability = { 946: "CONFLICTING", 947: "MERGEABLE" };
      headSha = "1111111111111111111111111111111111111111";
      drafts = new Set();
      approvals = new Set();
      timeline = [];
      historyReads = 0;
      duringRead = undefined;
      vi.stubEnv(
        "GITHUB_APP_BOT_EMAIL",
        "1234+sentry-junior[bot]@users.noreply.github.com",
      );
      mswServer.use(
        http.post("https://api.github.com/graphql", async ({ request }) => {
          const { variables } = (await request.json()) as {
            variables: { number?: number; query?: string };
          };
          if (variables.number !== undefined) {
            historyReads += 1;
            return HttpResponse.json({
              data: {
                repository: {
                  pullRequest: {
                    // An hour before `pushedAt`.
                    createdAt: new Date(pushedAt - 60 * minute).toISOString(),
                    reviewDecision: approvals.has(variables.number)
                      ? "APPROVED"
                      : null,
                    // GitHub's `last` windows of the query.
                    discussion: { nodes: discussion().slice(-50) },
                    pushes: { nodes: pushes().slice(-100) },
                  },
                },
              },
            });
          }
          searches.push(variables.query!);
          await duringRead?.();
          return HttpResponse.json({
            data: {
              search: {
                nodes: [946, 947].map((number) => ({
                  baseRefName: "main",
                  headRefOid: headSha,
                  isDraft: drafts.has(number),
                  mergeable: mergeability[number],
                  number,
                  state: "OPEN",
                  title: `Pull request ${number}`,
                  url: `https://github.com/getsentry/junior/pull/${number}`,
                })),
                pageInfo: { endCursor: null, hasNextPage: false },
              },
            },
          });
        }),
      );
      const row = (number: number, state: "merged" | "open") => ({
        number,
        openedAt: new Date(pushedAt - 60 * minute),
        pullRequestId: `${number}0`,
        repositoryFullName: "getsentry/junior",
        repositoryId: "1",
        state,
        updatedAt: new Date(pushedAt - 60 * minute),
      });
      await fixture
        .db()
        .insert(juniorGitHubPullRequests)
        .values([row(946, "open"), row(947, "open"), row(948, "merged")]);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("publishes a conflict with one search for a burst of pushes", async () => {
      await deliver("push-1", pushRequest("refs/heads/main"));
      vi.setSystemTime(pushedAt + minute);
      await deliver("push-2", pushRequest("refs/heads/main"));
      // The push webhook makes no GitHub call.
      expect(searches).toHaveLength(0);

      await heartbeat(pushedAt + minute);
      expect(searches).toHaveLength(0);

      await heartbeat(pushedAt + 2 * minute);
      // One search for the open Junior pull requests.
      expect(searches).toEqual([
        "repo:getsentry/junior is:pr is:open author:app/sentry-junior",
      ]);
      expect(conflicts()).toEqual([
        expect.objectContaining({
          data: {
            baseBranch: "main",
            headSha: "1111111111111111111111111111111111111111",
            pullRequest: 946,
            repo: "getsentry/junior",
            url: "https://github.com/getsentry/junior/pull/946",
          },
          identifier: "getsentry/junior#946",
        }),
        expect.objectContaining({ identifier: "getsentry/junior" }),
      ]);
      expect(pullRequestReads).toBe(0);
      // Only the conflicted pull request reads its history.
      expect(historyReads).toBe(1);

      await heartbeat(pushedAt + 10 * minute);
      expect(searches).toHaveLength(1);
    });

    it("reads again while GitHub calculates mergeability", async () => {
      mergeability[946] = "UNKNOWN";
      await deliver("push-1", pushRequest("refs/heads/main"));
      await heartbeat(pushedAt + 2 * minute);
      expect(searches).toHaveLength(1);
      expect(conflicts()).toEqual([]);

      mergeability[946] = "CONFLICTING";
      await heartbeat(pushedAt + 3 * minute);
      expect(searches).toHaveLength(2);
      expect(conflicts()).toHaveLength(2);
    });

    it("keeps a push that arrives during a check", async () => {
      await deliver("push-1", pushRequest("refs/heads/main"));
      vi.setSystemTime(pushedAt + 2 * minute);
      duringRead = async () => {
        duringRead = undefined;
        await deliver("push-2", pushRequest("refs/heads/main"));
      };
      await heartbeat(pushedAt + 2 * minute);
      expect(searches).toHaveLength(1);

      await heartbeat(pushedAt + 4 * minute);
      expect(searches).toHaveLength(2);
    });

    it("does not check after a push to another branch", async () => {
      await deliver("push-1", pushRequest("refs/heads/feat/other"));
      await heartbeat(pushedAt + 10 * minute);
      expect(searches).toHaveLength(0);
    });

    it("does not check a repository without open Junior pull requests", async () => {
      await deliver(
        "push-1",
        pushRequest("refs/heads/main", "getsentry/other"),
      );
      await heartbeat(pushedAt + 10 * minute);
      expect(searches).toHaveLength(0);
    });

    it("publishes no conflict that nothing wants", async () => {
      h.watches.conflicts = false;
      await deliver("push-1", pushRequest("refs/heads/main"));
      await heartbeat(pushedAt + 2 * minute);
      expect(searches).toHaveLength(1);
      expect(conflicts()).toEqual([]);
    });

    const hour = 60 * minute;
    const day = 24 * hour;

    /** Fix events for 946. Core delivers each event key once. */
    const fixedShas = () => [
      ...new Set(
        conflicts()
          .filter((event) => event.identifier === "getsentry/junior#946")
          .map((event) => String(event.data?.["headSha"]).slice(0, 1)),
      ),
    ];

    /**
     * Push to main with a head commit on 946, and run the check. A published
     * fix adds Junior's merge commit on GitHub.
     */
    async function checkAt(nowMs: number, sha: string): Promise<void> {
      vi.setSystemTime(nowMs);
      headSha = sha.repeat(40);
      await deliver(`push-${nowMs}`, pushRequest("refs/heads/main"));
      vi.setSystemTime(nowMs + 2 * minute);
      const fixes = fixedShas().length;
      await heartbeat(nowMs + 2 * minute);
      if (fixedShas().length > fixes) {
        timeline.push({
          __typename: "PullRequestCommit",
          commit: {
            author: { user: { login: "sentry-junior[bot]" } },
            committedDate: new Date(nowMs + 10 * minute).toISOString(),
            parents: { totalCount: 2 },
          },
        });
      }
    }

    /** A review or comment on 946 on GitHub. */
    function reviewAt(nowMs: number, author: "Bot" | "User"): void {
      timeline.push({
        __typename: "PullRequestReview",
        author: { __typename: author },
        submittedAt: new Date(nowMs).toISOString(),
      });
    }

    async function askedInSlack(): Promise<void> {
      await fixture
        .db()
        .insert(juniorGitHubPullRequestRequesters)
        .values({
          conversationId: "slack:C1:1.0",
          createdAt: new Date(pushedAt),
          identityId: "identity-jane",
          number: 946,
          repositoryFullName: "getsentry/junior",
          updatedAt: new Date(pushedAt),
        });
    }

    it("closes the notice when the conflict is gone, and adds one for the next conflict", async () => {
      await askedInSlack();
      await checkAt(pushedAt + 2 * day, "1");
      expect(h.notices).toHaveLength(1);

      mergeability[946] = "MERGEABLE";
      await checkAt(pushedAt + 2 * day + hour, "2");
      // Nothing is left to close.
      await checkAt(pushedAt + 2 * day + 2 * hour, "2");
      expect(h.closedNotices).toEqual(["merge-conflict:getsentry/junior#946"]);

      mergeability[946] = "CONFLICTING";
      await checkAt(pushedAt + 2 * day + 3 * hour, "3");
      expect(h.notices).toHaveLength(2);
      expect(fixedShas()).toEqual([]);
    });

    it("publishes no conflict for a draft", async () => {
      drafts.add(946);
      await deliver("push-1", pushRequest("refs/heads/main"));
      await heartbeat(pushedAt + 2 * minute);
      expect(searches).toHaveLength(1);
      expect(conflicts()).toEqual([]);
      expect(h.notices).toEqual([]);
      expect(historyReads).toBe(0);
    });

    it("fixes once a day while people work on the pull request", async () => {
      await askedInSlack();
      await checkAt(pushedAt, "1");
      // Main moved again, but the last fix was less than a day ago.
      await checkAt(pushedAt + 6 * hour, "2");
      expect(fixedShas()).toEqual(["1"]);

      // A review by a person keeps the pull request active.
      reviewAt(pushedAt + 30 * hour, "User");
      await checkAt(pushedAt + 31 * hour, "3");
      await checkAt(pushedAt + 56 * hour, "4");
      expect(fixedShas()).toEqual(["1", "3", "4"]);
      expect(h.notices).toEqual([]);

      // After the third fix, Junior adds one notice. Many comments do not
      // hide the fixes.
      for (let i = 0; i < 120; i += 1) {
        timeline.push({
          __typename: "IssueComment",
          author: { __typename: "User" },
          createdAt: new Date(pushedAt + 57 * hour).toISOString(),
        });
      }
      await checkAt(pushedAt + 3 * day, "5");
      await checkAt(pushedAt + 3 * day + 6 * hour, "6");
      expect(fixedShas()).toEqual(["1", "3", "4"]);
      expect(h.notices).toEqual([
        {
          conversationId: "slack:C1:1.0",
          notice: {
            assigneeIdentityIds: ["identity-jane"],
            body: "**Pull request 946** has merge conflicts with `main`. Junior stopped fixing them on its own, because Junior already fixed conflicts 3 times. If they are still there, ask Junior in this thread to fix them: https://github.com/getsentry/junior/pull/946",
            dedupeKey: "merge-conflict:getsentry/junior#946",
            subject: {
              id: "https://github.com/getsentry/junior/pull/946",
              title: "Pull request 946 (#946)",
              url: "https://github.com/getsentry/junior/pull/946",
            },
            title: "Merge conflict · #946",
          },
        },
      ]);
    });

    it("adds one notice when nobody worked on it for 2 days, then stops until it is approved", async () => {
      await askedInSlack();
      // The pull request opened an hour before `pushedAt`. A review by a bot
      // is not activity by a person. The first notice fails, so the next
      // check adds it.
      reviewAt(pushedAt + day, "Bot");
      h.failures.upsert = 1;
      await checkAt(pushedAt + 2 * day, "1");
      expect(h.notices).toEqual([]);
      await checkAt(pushedAt + 2 * day + 3 * hour, "1");
      await checkAt(pushedAt + 2 * day + 6 * hour, "2");
      expect(fixedShas()).toEqual([]);
      expect(h.notices.map(({ notice }) => notice.body)).toEqual([
        expect.stringContaining(
          "because nobody worked on it in the last 2 days",
        ),
      ]);

      // After 3 days without activity, a conflict does nothing.
      await checkAt(pushedAt + 3 * day, "3");
      expect(fixedShas()).toEqual([]);
      expect(h.notices).toHaveLength(1);

      // An approved pull request waits only for the fix to merge, so it
      // gets one at once, until the total limit. A check of the same head
      // commit does not count as another fix.
      approvals.add(946);
      await checkAt(pushedAt + 4 * day, "4");
      await checkAt(pushedAt + 4 * day + 30 * minute, "4");
      await checkAt(pushedAt + 4 * day + hour, "5");
      await checkAt(pushedAt + 4 * day + 2 * hour, "6");
      await checkAt(pushedAt + 4 * day + 3 * hour, "7");
      expect(fixedShas()).toEqual(["4", "5", "6"]);
      // The notice stays until the conflict is gone.
      expect(h.closedNotices).toEqual([]);
    });
  });
});
