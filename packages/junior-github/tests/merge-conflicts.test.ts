import { generateKeyPairSync } from "node:crypto";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { juniorGitHubPullRequestRequesters } from "../src/db/schema";
import { recordJuniorPullRequest } from "./code-index";
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
    draft: false,
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
  /** Runs once, in the next read of the pull request. */
  let duringPullRequestRead: (() => Promise<void>) | undefined;

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
    duringPullRequestRead = undefined;
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
        async () => {
          pullRequestReads += 1;
          const hook = duringPullRequestRead;
          duringPullRequestRead = undefined;
          await hook?.();
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

  it("reads an unchanged pull request again with its ETag", async () => {
    const etag = 'W/"pull-946"';
    const answers: number[] = [];
    mswServer.use(
      http.get(
        "https://api.github.com/repos/getsentry/junior/pulls/946",
        ({ request }) => {
          if (request.headers.get("if-none-match") === etag) {
            answers.push(304);
            return new HttpResponse(null, { status: 304 });
          }
          answers.push(200);
          return HttpResponse.json(pullRequest, { headers: { etag } });
        },
      ),
    );
    await deliver("delivery-1");
    await deliver("delivery-2");
    expect(answers).toEqual([200, 304]);
    // The saved pull request still shows the conflict.
    expect(conflicts().map((event) => event.eventKey)).toEqual(
      Array.from({ length: 4 }, () =>
        expect.stringContaining(":1111111111111111111111111111111111111111"),
      ),
    );
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

  it("drops the conflict mark on a clean read that only conflict waiters start", async () => {
    const fixes = () =>
      h.published.filter(
        (event) => event.eventType === "pull_request.merge_conflict.resolved",
      );
    await deliver("delivery-1");
    expect(conflicts()).toHaveLength(2);

    // A change on the base branch fixed it, and nothing waits for the fix.
    pullRequest = pullRequestResponse({
      headSha: "1111111111111111111111111111111111111111",
      mergeable: true,
      mergeableState: "clean",
    });
    await deliver("delivery-2");
    const published = fixes().length;

    // A waiter that comes later does not get that earlier fix.
    h.watches.fixes = true;
    await deliver("delivery-3");
    expect(fixes()).toHaveLength(published);
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
        http.get(
          "https://api.github.com/repos/getsentry/junior/contents/.github/release.yml",
          () => HttpResponse.json({ message: "Not Found" }, { status: 404 }),
        ),
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
                  title: `fix(conflicts): Pull request ${number}`,
                  url: `https://github.com/getsentry/junior/pull/${number}`,
                })),
                pageInfo: { endCursor: null, hasNextPage: false },
              },
            },
          });
        }),
      );
      const updatedAt = new Date(pushedAt - 60 * minute);
      await recordJuniorPullRequest(fixture, {
        number: 946,
        updatedAt,
      });
      await recordJuniorPullRequest(fixture, {
        number: 947,
        updatedAt,
      });
      await recordJuniorPullRequest(fixture, {
        finishedAt: updatedAt,
        number: 948,
        state: "merged",
        updatedAt,
      });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("clears a conflict that the cache entry still knows when the pull request is mergeable", async () => {
      const key = "pulls:getsentry/junior#947";
      await h.cache.update(key, () => ({
        ttlMs: 60 * minute,
        value: { head: { sha: headSha }, mergeable: false, state: "open" },
      }));
      await deliver("push-1", pushRequest("refs/heads/main"));
      await heartbeat(pushedAt + 2 * minute);

      expect(await h.cache.get(key)).toEqual({
        head: { sha: headSha },
        mergeable: true,
        state: "open",
      });
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

    it("checks after a push that names the repository in another case", async () => {
      await deliver(
        "push-1",
        pushRequest("refs/heads/main", "GetSentry/Junior"),
      );
      await heartbeat(pushedAt + 2 * minute);
      expect(searches).toEqual([
        "repo:getsentry/junior is:pr is:open author:app/sentry-junior",
      ]);
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

    /** Push to main with a head commit on 946, and run the check. */
    async function checkAt(nowMs: number, sha: string): Promise<void> {
      vi.setSystemTime(nowMs);
      headSha = sha.repeat(40);
      await deliver(`push-${nowMs}`, pushRequest("refs/heads/main"));
      vi.setSystemTime(nowMs + 2 * minute);
      await heartbeat(nowMs + 2 * minute);
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
          pullRequestId: "9460",
          repositoryFullName: "getsentry/junior",
          updatedAt: new Date(pushedAt),
        });
    }

    /** Fix 946 with head `1`, and check it a day later with the same head. */
    async function fixThatDoesNotLand(): Promise<void> {
      approvals.add(946);
      await checkAt(pushedAt, "1");
      await checkAt(pushedAt + day, "1");
    }

    const resume = {
      choice: "Resume",
      conversationId: "slack:C1:1.0",
      itemId: "item-1",
      subject: { id: "9460", kind: "merge_conflict" },
      nowMs: pushedAt + day + hour,
    };

    it("closes the merge conflict item when the conflict is gone", async () => {
      await askedInSlack();
      await fixThatDoesNotLand();
      expect(h.notices).toHaveLength(1);

      mergeability[946] = "MERGEABLE";
      await checkAt(pushedAt + day + hour, "2");
      // Nothing is left to close.
      await checkAt(pushedAt + day + 2 * hour, "2");
      expect(h.closedNotices).toEqual(["merge_conflict:9460"]);

      // The closed item was not dismissed, so when the conflict comes back
      // and the fix still did not land, Junior asks again.
      mergeability[946] = "CONFLICTING";
      await checkAt(pushedAt + day + 3 * hour, "1");
      expect(h.notices).toHaveLength(2);
    });

    it("asks no more after a Dismiss, also after the conflict goes and comes back", async () => {
      await askedInSlack();
      await fixThatDoesNotLand();
      expect(h.notices).toHaveLength(1);
      h.dismiss("merge_conflict:9460");

      mergeability[946] = "MERGEABLE";
      await checkAt(pushedAt + day + hour, "1");
      mergeability[946] = "CONFLICTING";
      await checkAt(pushedAt + day + 2 * hour, "1");
      expect(h.closedNotices).toEqual([]);
      expect(h.notices).toHaveLength(1);
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

      // Many comments do not hide the last fix, so the daily wait holds.
      for (let i = 0; i < 120; i += 1) {
        timeline.push({
          __typename: "IssueComment",
          author: { __typename: "User" },
          createdAt: new Date(pushedAt + 57 * hour).toISOString(),
        });
      }
      await checkAt(pushedAt + 3 * day, "5");
      expect(fixedShas()).toEqual(["1", "3", "4"]);
      // People still work on it, so the fixes go on past 3 in total.
      await checkAt(pushedAt + 3 * day + 9 * hour, "6");
      expect(fixedShas()).toEqual(["1", "3", "4", "6"]);
      expect(h.notices).toEqual([]);
    });

    it("fixes nothing and asks nobody when nobody worked on it for 2 days, until it is approved", async () => {
      await askedInSlack();
      // The pull request opened an hour before `pushedAt`. A review by a bot
      // is not activity by a person.
      reviewAt(pushedAt + day, "Bot");
      await checkAt(pushedAt + 2 * day, "1");
      await checkAt(pushedAt + 3 * day, "2");
      expect(fixedShas()).toEqual([]);

      // An approved pull request waits only for the fix to merge, so it
      // gets one at once, up to 3 in a row. A check of the same head commit
      // does not count as another fix.
      approvals.add(946);
      await checkAt(pushedAt + 4 * day, "4");
      await checkAt(pushedAt + 4 * day + 30 * minute, "4");
      await checkAt(pushedAt + 4 * day + hour, "5");
      await checkAt(pushedAt + 4 * day + 2 * hour, "6");
      await checkAt(pushedAt + 4 * day + 3 * hour, "7");
      expect(fixedShas()).toEqual(["4", "5", "6"]);
      // Junior waits for a person after 3 fixes in a row, and tells nobody.
      expect(h.notices).toEqual([]);

      // Activity by a person starts the count again.
      reviewAt(pushedAt + 4 * day + 4 * hour, "User");
      await checkAt(pushedAt + 4 * day + 5 * hour, "8");
      expect(fixedShas()).toEqual(["4", "5", "6", "8"]);
    });

    it("counts only the fixes it started, not merges and force pushes for requested work", async () => {
      await askedInSlack();
      // Junior merged main and force-pushed for work that a person asked for
      // in Slack, with no activity by a person on GitHub.
      for (let i = 1; i <= 3; i += 1) {
        timeline.push(
          {
            __typename: "PullRequestCommit",
            commit: {
              author: { user: { login: "sentry-junior[bot]" } },
              committedDate: new Date(pushedAt + i * hour).toISOString(),
            },
          },
          {
            __typename: "HeadRefForcePushedEvent",
            actor: { __typename: "Bot" },
            createdAt: new Date(pushedAt + i * hour + minute).toISOString(),
          },
        );
      }
      await checkAt(pushedAt + 4 * hour, "1");
      expect(fixedShas()).toEqual(["1"]);
      expect(h.notices).toEqual([]);
    });

    it("fixes a head commit once, and asks once to resume when that fix lands nothing in a day", async () => {
      await askedInSlack();
      approvals.add(946);
      await checkAt(pushedAt, "1");
      await checkAt(pushedAt + hour, "1");
      expect(fixedShas()).toEqual(["1"]);
      expect(h.notices).toEqual([]);
      // The first ask fails, so the next check asks.
      h.failures.upsert = 1;
      await checkAt(pushedAt + day, "1");
      expect(h.notices).toEqual([]);
      await checkAt(pushedAt + day + hour, "1");
      expect(h.notices).toEqual([
        {
          conversationId: "slack:C1:1.0",
          notice: {
            askedIdentityIds: ["identity-jane"],
            assigneeIdentityIds: ["identity-jane"],
            body: "#946 conflicts with `main`, and the last fix did not land. Resume tries again. Dismiss stops these asks for this pull request.",
            choices: [{ label: "Resume" }],
            subject: {
              id: "9460",
              kind: "merge_conflict",
            },
            title: "Merge conflict · #946",
          },
        },
      ]);

      // A Dismiss tells the plugin nothing. Junior asked once, so it does
      // not ask again, also after activity by a person.
      h.dismiss("merge_conflict:9460");
      reviewAt(pushedAt + 2 * day, "User");
      await checkAt(pushedAt + 2 * day + hour, "1");
      expect(h.notices).toHaveLength(1);
      expect(fixedShas()).toEqual(["1"]);
    });

    it("publishes a fix again when its publish failed", async () => {
      await askedInSlack();
      h.failures.publish = 1;
      await checkAt(pushedAt, "1").catch(() => undefined);
      expect(fixedShas()).toEqual([]);
      // The next check of the same head commit publishes the same event key,
      // which core delivers once.
      await checkAt(pushedAt + 10 * minute, "1");
      expect(fixedShas()).toEqual(["1"]);
    });

    it("asks again at once when the fix that Resume publishes fails", async () => {
      await askedInSlack();
      await fixThatDoesNotLand();
      expect(h.notices).toHaveLength(1);
      pullRequest.head.sha = "1".repeat(40);
      h.failures.publish = 1;
      await expect(h.answer(resume)).rejects.toThrow("The event queue is down");
      await checkAt(pushedAt + day + hour + 10 * minute, "1");
      expect(h.notices).toHaveLength(2);
    });

    it("Resume starts a fix and the count again", async () => {
      await askedInSlack();
      await fixThatDoesNotLand();
      expect(h.notices).toHaveLength(1);

      // Resume reads the head commit from GitHub and starts a fix of it,
      // even when a check already started one of the same commit.
      pullRequest.head.sha = "1".repeat(40);
      // The Conversation's Watch expired while fixes waited, though another
      // Conversation still watches. Resume adds the Watch again before it
      // starts the fix, so the fix reaches the Conversation.
      h.watches.ownConflicts = false;
      const publishedBefore = h.published.length;
      await h.answer(resume);
      expect(h.subscribed).toEqual([
        {
          events: expect.arrayContaining(["pull_request.merge_conflict"]),
          identifier: "getsentry/junior#946",
          publishedBefore,
        },
      ]);
      const resumed = conflicts().filter((event) =>
        event.eventKey.endsWith(":resume:item-1"),
      );
      expect(resumed).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({ headSha: "1".repeat(40) }),
          identifier: "getsentry/junior#946",
        }),
        expect.objectContaining({ identifier: "getsentry/junior" }),
      ]);
      // Until the fix that Resume started lands, a check starts no second
      // fix, though an approved pull request skips the daily wait.
      const published = conflicts().length;
      await checkAt(pushedAt + day + hour + 10 * minute, "1");
      expect(conflicts()).toHaveLength(published);

      // The count starts again from the Resume, so the next conflicts get
      // fixes, up to 3 in a row with the fix that Resume started.
      await checkAt(pushedAt + day + 2 * hour, "5");
      await checkAt(pushedAt + day + 3 * hour, "6");
      await checkAt(pushedAt + day + 4 * hour, "7");
      expect(fixedShas()).toEqual(["1", "5", "6"]);
      expect(h.notices).toHaveLength(1);
    });

    it("Resume reads the current repository name from the code index", async () => {
      await askedInSlack();
      await fixThatDoesNotLand();
      expect(h.notices).toHaveLength(1);
      // The opener's row keeps the name from when Junior opened it.
      await fixture
        .db()
        .update(juniorGitHubPullRequestRequesters)
        .set({ repositoryFullName: "getsentry/junior-old" });
      pullRequest.head.sha = "1".repeat(40);
      await h.answer(resume);
      expect(
        conflicts().filter((event) =>
          event.eventKey.endsWith(":resume:item-1"),
        ),
      ).toEqual([
        expect.objectContaining({ identifier: "getsentry/junior#946" }),
        expect.objectContaining({ identifier: "getsentry/junior" }),
      ]);
    });

    it("lets the next conflict ask again when Resume finds no pull request", async () => {
      await askedInSlack();
      await fixThatDoesNotLand();
      expect(h.notices).toHaveLength(1);
      // No pull request with the item's id was opened in this Conversation,
      // so the Resume starts no fix. Core closed the item already.
      const published = conflicts().length;
      await h.answer({ ...resume, conversationId: "slack:C9:9.0" });
      expect(conflicts()).toHaveLength(published);
      await checkAt(pushedAt + day + hour + 10 * minute, "1");
      expect(h.notices).toHaveLength(2);
    });

    it("adds no item for a conflict check that runs while Resume reads the pull request", async () => {
      await askedInSlack();
      await fixThatDoesNotLand();
      expect(h.notices).toHaveLength(1);
      pullRequest.head.sha = "1".repeat(40);
      duringPullRequestRead = () => checkAt(pushedAt + day + hour, "1");
      await h.answer(resume);
      expect(duringPullRequestRead).toBeUndefined();
      expect(h.notices).toHaveLength(1);
    });

    it("saves no Resume that starts no fix, so the next conflict asks again", async () => {
      await askedInSlack();
      await fixThatDoesNotLand();
      expect(h.notices).toHaveLength(1);
      // A draft gets no fix, so Resume saves nothing, and the next conflict
      // asks again at once, with no wait for a fix.
      pullRequest.draft = true;
      const published = conflicts().length;
      await h.answer(resume);
      pullRequest.draft = false;
      await checkAt(pushedAt + day + hour + 10 * minute, "1");
      // The same holds when GitHub can merge it by the time of the Resume.
      pullRequest.mergeable = true;
      await h.answer({ ...resume, itemId: "item-2" });
      await checkAt(pushedAt + day + hour + 20 * minute, "1");
      expect(conflicts()).toHaveLength(published);
      expect(h.notices).toHaveLength(3);
    });

    it("asks again once when the fix that Resume started lands nothing in a day", async () => {
      await askedInSlack();
      await fixThatDoesNotLand();
      expect(h.notices).toHaveLength(1);
      pullRequest.head.sha = "1".repeat(40);
      await h.answer(resume);
      // The Watch is still active, so Resume adds no second one.
      expect(h.subscribed).toEqual([]);

      // Core already delivered a fix of this head commit, and Resume closed
      // the item. So when no fix lands, the next check a day later asks
      // again, once, and Resume on the new item starts another fix.
      await checkAt(pushedAt + day + hour + 10 * minute, "1");
      expect(h.notices).toHaveLength(1);
      await checkAt(pushedAt + 2 * day + hour, "1");
      await checkAt(pushedAt + 2 * day + 2 * hour, "1");
      expect(h.notices).toHaveLength(2);
      await h.answer({
        ...resume,
        itemId: "item-2",
        nowMs: pushedAt + 2 * day + 3 * hour,
      });
      expect(
        conflicts().filter((event) =>
          event.eventKey.endsWith(":resume:item-2"),
        ),
      ).not.toEqual([]);
    });
  });
});
