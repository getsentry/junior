import { createHmac, generateKeyPairSync } from "node:crypto";
import type {
  CodeChangeInput,
  ConversationAnnotationInput,
  EventInput,
  EventPublisher,
  HeartbeatHookContext,
  PluginState,
} from "@sentry/junior-plugin-api";
import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { juniorGitHubPullRequests } from "../src/db/schema";
import { githubPlugin } from "../src/index";
import { createGitHubFixture, type GitHubFixture } from "./github-db";
import { mswServer } from "./msw";

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

/** A signed GitHub webhook delivery. */
function signedRequest(input: {
  body: unknown;
  deliveryId: string;
  eventName: string;
}): Request {
  const body = JSON.stringify(input.body);
  return new Request("https://example.test/api/webhooks/github", {
    method: "POST",
    headers: {
      "x-github-delivery": input.deliveryId,
      "x-github-event": input.eventName,
      "x-hub-signature-256": `sha256=${createHmac("sha256", "test-secret")
        .update(body)
        .digest("hex")}`,
    },
    body,
  });
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
  let published: EventInput[];
  let pullRequestReads: number;
  let pullRequest: ReturnType<typeof pullRequestResponse>;
  let watchesComments: boolean;
  let watchesConflicts: boolean;
  let reactions: number;
  let annotations: Array<{
    annotation: ConversationAnnotationInput;
    conversationId: string;
  }>;
  let codeChanges: CodeChangeInput[];
  let heartbeatLogs: Array<[level: string, message: string]>;

  let stored: Map<string, { expiresAtMs: number; value: unknown }>;
  const live = (key: string) => {
    const entry = stored.get(key);
    if (entry && entry.expiresAtMs <= Date.now()) stored.delete(key);
    return stored.get(key);
  };
  const store = (key: string, value: unknown, ttlMs?: number) => {
    stored.set(key, {
      expiresAtMs: ttlMs ? Date.now() + ttlMs : Infinity,
      value: structuredClone(value),
    });
  };
  const state: PluginState = {
    async delete(key) {
      stored.delete(key);
    },
    async get<T>(key: string) {
      return live(key)?.value as T | undefined;
    },
    async set(key, value, ttlMs) {
      store(key, value, ttlMs);
    },
    async setIfNotExists(key, value, ttlMs) {
      if (live(key)) return false;
      store(key, value, ttlMs);
      return true;
    },
    async withLock(_key, _ttlMs, callback) {
      return await callback();
    },
  };

  const events: EventPublisher = {
    // The Watch made after Junior creates a pull request.
    async hasMatch(candidates) {
      return candidates.some(
        (event) =>
          event.identifier === "getsentry/junior#946" &&
          (event.eventType === "pull_request.merge_conflict"
            ? watchesConflicts
            : watchesComments),
      );
    },
    async publish(event) {
      published.push(event);
    },
  };

  async function deliver(
    deliveryId: string,
    request: Request = commentRequest(deliveryId),
  ): Promise<void> {
    const [route] = githubPlugin().hooks!.routes!({
      annotations: {
        forConversation() {
          return {
            async upsert() {},
            async remove() {},
            async list() {
              return [];
            },
          };
        },
      },
      cache: {
        async getOrLoad(_key, load) {
          return (await load()).value;
        },
      },
      codeChanges: {
        async associateConversations() {},
        async recordActivity() {},
        async record() {},
      },
      db: fixture.db(),
      events,
      log: { error() {}, info() {}, warn() {} },
      plugin: { name: "github" },
      state,
      users: {
        async readIdentity() {
          return undefined;
        },
      },
    });
    const response = await route!.handler(request);
    expect(response.status).toBe(202);
  }

  async function heartbeat(nowMs: number): Promise<void> {
    const unused = () => {
      throw new Error("The GitHub heartbeat does not use this");
    };
    const context: HeartbeatHookContext = {
      agent: { dispatch: unused, get: unused },
      annotations: {
        forConversation(conversationId) {
          return {
            async upsert(annotation) {
              annotations.push({ annotation, conversationId });
            },
            async remove() {},
            async list() {
              return [];
            },
          };
        },
      },
      cache: {
        async getOrLoad(_key, load) {
          return (await load()).value;
        },
      },
      codeChanges: {
        async associateConversations() {},
        async recordActivity() {},
        async record(input) {
          codeChanges.push(input);
        },
      },
      db: fixture.db(),
      embedder: { embedTexts: unused, model: "unused", provider: "unused" },
      events,
      log: {
        error: (message) => heartbeatLogs.push(["error", message]),
        info() {},
        warn: (message) => heartbeatLogs.push(["warn", message]),
      },
      nowMs,
      plugin: { name: "github" },
      state,
    };
    await githubPlugin().hooks!.heartbeat!(context);
  }

  const conflicts = () =>
    published.filter(
      (event) => event.eventType === "pull_request.merge_conflict",
    );

  beforeEach(async () => {
    fixture = await createGitHubFixture();
    stored = new Map();
    published = [];
    pullRequestReads = 0;
    watchesComments = true;
    watchesConflicts = true;
    reactions = 0;
    annotations = [];
    codeChanges = [];
    heartbeatLogs = [];
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

    expect(published.map((event) => event.eventType)).toEqual([
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
    watchesConflicts = false;
    await deliver("delivery-1");
    expect(pullRequestReads).toBe(0);
    expect(conflicts()).toEqual([]);
  });

  it("does not mark a comment when only conflicts are watched", async () => {
    watchesComments = false;
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
      duringRead = undefined;
      vi.stubEnv(
        "GITHUB_APP_BOT_EMAIL",
        "1234+sentry-junior[bot]@users.noreply.github.com",
      );
      mswServer.use(
        http.post("https://api.github.com/graphql", async ({ request }) => {
          const { variables } = (await request.json()) as {
            variables: { query: string };
          };
          searches.push(variables.query);
          await duringRead?.();
          return HttpResponse.json({
            data: {
              search: {
                nodes: [946, 947].map((number) => ({
                  baseRefName: "main",
                  headRefOid: "1111111111111111111111111111111111111111",
                  mergeable: mergeability[number],
                  number,
                  state: "OPEN",
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
      watchesConflicts = false;
      await deliver("push-1", pushRequest("refs/heads/main"));
      await heartbeat(pushedAt + 2 * minute);
      expect(searches).toHaveLength(1);
      expect(conflicts()).toEqual([]);
    });
  });

  describe("daily reconcile of open pull requests", () => {
    const now = Date.parse("2026-11-09T12:00:00.000Z");
    const day = 24 * 60 * 60_000;
    let queries: number[][];
    let drafts: Set<number>;

    /** A pull request lifecycle as GitHub GraphQL returns it. */
    function lifecycle(number: number) {
      const closed = number === 946 || number === 949;
      const merged = number === 946;
      return {
        assignees: { nodes: [{ login: "octocat" }] },
        author: { __typename: "Bot", login: "sentry-junior" },
        closedAt: closed ? new Date(now - day).toISOString() : null,
        createdAt: new Date(now - 3 * day).toISOString(),
        databaseId: number * 10,
        headRefName: `feat/pr-${number}`,
        isDraft: drafts.has(number),
        merged,
        mergedAt: merged ? new Date(now - day).toISOString() : null,
        number,
        state: merged ? "MERGED" : closed ? "CLOSED" : "OPEN",
        title: `Pull request ${number}`,
        updatedAt: new Date(now - day).toISOString(),
      };
    }

    beforeEach(async () => {
      vi.useFakeTimers({ now, toFake: ["Date"] });
      queries = [];
      drafts = new Set();
      vi.stubEnv(
        "GITHUB_APP_BOT_EMAIL",
        "1234+sentry-junior[bot]@users.noreply.github.com",
      );
      mswServer.use(
        // GitHub finds a token's repositories by their current name or id.
        http.post(
          "https://api.github.com/app/installations/456/access_tokens",
          async ({ request }) => {
            const body = (await request.json()) as {
              repositories?: string[];
              repository_ids?: number[];
            };
            const reachable =
              (body.repositories ?? []).every((name) => name === "junior") &&
              (body.repository_ids ?? []).every((id) => id === 1);
            return reachable
              ? HttpResponse.json({
                  expires_at: "2027-01-01T00:00:00.000Z",
                  token: "installation-token",
                })
              : HttpResponse.json(
                  {
                    message:
                      "There is at least one repository that does not exist or is not accessible to the parent installation.",
                  },
                  { status: 422 },
                );
          },
        ),
        http.get("https://api.github.com/repositories/1", () =>
          HttpResponse.json({ full_name: "getsentry/junior", id: 1 }),
        ),
        http.get(
          "https://api.github.com/repos/getsentry/junior/pulls/946/commits",
          () =>
            HttpResponse.json([
              {
                author: { login: "jane" },
                commit: {
                  message:
                    "Fix the close\n\nCo-authored-by: Sam <sam@example.com>",
                },
              },
            ]),
        ),
        http.post("https://api.github.com/graphql", async ({ request }) => {
          const { variables } = (await request.json()) as {
            variables: Record<string, unknown>;
          };
          const numbers = Object.entries(variables)
            .filter(([name]) => /^n\d+$/.test(name))
            .map(([, number]) => number as number);
          queries.push(numbers);
          return HttpResponse.json({
            data: {
              repository: {
                databaseId: 1,
                nameWithOwner: "getsentry/junior",
                ...Object.fromEntries(
                  numbers.map((number, index) => [
                    `pr${index}`,
                    // GitHub deleted pull request 951.
                    number === 951 ? null : lifecycle(number),
                  ]),
                ),
              },
            },
          });
        }),
      );
      const row = (number: number, updatedAt: number) => ({
        conversationIds: ["slack:C1:1.0"],
        number,
        openedAt: new Date(now - 3 * day),
        pullRequestId: `${number}0`,
        repositoryFullName: "getsentry/junior",
        repositoryId: "1",
        state: "open" as const,
        updatedAt: new Date(updatedAt),
      });
      await fixture
        .db()
        .insert(juniorGitHubPullRequests)
        .values([
          row(946, now - 2 * day),
          row(947, now - 2 * day),
          row(949, now - 2 * day),
          row(951, now - 2 * day),
          // Its close webhook can still arrive.
          row(950, now - 60_000),
        ]);
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it("records closes that GitHub did not deliver, once a day", async () => {
      await heartbeat(now);

      expect(queries.map((numbers) => numbers.sort())).toEqual([
        [946, 947, 949, 951],
      ]);
      const rows = await fixture
        .db()
        .select()
        .from(juniorGitHubPullRequests)
        .orderBy(juniorGitHubPullRequests.number);
      expect(
        rows.map((row) => [row.number, row.state, row.mergedAt, row.closedAt]),
      ).toEqual([
        [946, "merged", new Date(now - day), new Date(now - day)],
        [947, "open", null, null],
        [949, "closed_unmerged", null, new Date(now - day)],
        [950, "open", null, null],
        [951, "open", null, null],
      ]);
      expect(
        codeChanges.map((change) => [change.number, change.state]),
      ).toEqual([
        [946, "merged"],
        [949, "closed"],
      ]);
      expect(
        annotations.map(({ annotation, conversationId }) => [
          conversationId,
          annotation.key,
          annotation.status,
        ]),
      ).toEqual([
        ["slack:C1:1.0", "getsentry/junior#946", "merged"],
        ["slack:C1:1.0", "getsentry/junior#949", "closed"],
      ]);

      vi.setSystemTime(now + 60_000);
      await heartbeat(now + 60_000);
      expect(queries).toHaveLength(1);
      // The next day, the row that waited for its webhook is checked too.
      vi.setSystemTime(now + day);
      await heartbeat(now + day);
      expect(queries[1]?.sort()).toEqual([947, 950, 951]);
    });

    it("writes a draft state that changed on GitHub", async () => {
      drafts = new Set([947]);
      await heartbeat(now);

      const [row] = await fixture
        .db()
        .select()
        .from(juniorGitHubPullRequests)
        .where(eq(juniorGitHubPullRequests.number, 947));
      expect(row).toMatchObject({ draft: true, state: "open" });
      expect(
        codeChanges.map((change) => [
          change.number,
          change.state,
          change.draft,
        ]),
      ).toEqual([
        [946, "merged", undefined],
        [947, "open", true],
        [949, "closed", undefined],
      ]);
    });

    it("publishes a corrected close with the key of its webhook", async () => {
      const closes = () =>
        published.filter(
          (event) =>
            event.identifier === "getsentry/junior#946" &&
            event.eventType === "pull_request.merged",
        );
      await heartbeat(now);
      expect(closes()).toEqual([
        expect.objectContaining({
          data: {
            headBranch: "feat/pr-946",
            isDraft: false,
            openerUsername: "sentry-junior[bot]",
            pullRequest: 946,
            repo: "getsentry/junior",
          },
          objectType: "code_change",
          occurredAtMs: now - day,
          people: [
            { handle: "octocat", provider: "github" },
            { handle: "jane", provider: "github" },
            { email: "sam@example.com" },
          ],
          terminal: true,
          trustedSummary: "GitHub PR getsentry/junior#946 was merged.",
        }),
      ]);
      expect(
        published.filter(
          (event) => event.eventType === "pull_request.closed_unmerged",
        ),
      ).toHaveLength(2);

      // The late webhook has the same key, so a Watch gets the merge once.
      const merged = lifecycle(946);
      await deliver(
        "delivery-merge",
        signedRequest({
          deliveryId: "delivery-merge",
          eventName: "pull_request",
          body: {
            action: "closed",
            installation: { id: 456 },
            pull_request: {
              assignees: [{ login: "octocat" }],
              closed_at: merged.closedAt,
              created_at: merged.createdAt,
              id: merged.databaseId,
              merged: true,
              merged_at: merged.mergedAt,
              number: 946,
              updated_at: merged.updatedAt,
              user: { login: "sentry-junior[bot]" },
            },
            repository: { full_name: "getsentry/junior", id: 1 },
            sender: { login: "jane" },
          },
        }),
      );
      expect(closes()).toHaveLength(2);
      const [reconciled, webhook] = closes();
      expect(reconciled?.eventKey).toBe(webhook?.eventKey);
      expect(reconciled?.people).toEqual(webhook?.people);
    });

    const rowStates = async () =>
      (
        await fixture
          .db()
          .select()
          .from(juniorGitHubPullRequests)
          .orderBy(juniorGitHubPullRequests.number)
      ).map((row) => [row.number, row.state]);

    it("finds a renamed repository by its id", async () => {
      await fixture
        .db()
        .update(juniorGitHubPullRequests)
        .set({ repositoryFullName: "getsentry/junior-old" });
      await heartbeat(now);

      expect(heartbeatLogs).toEqual([]);
      expect(await rowStates()).toEqual([
        [946, "merged"],
        [947, "open"],
        [949, "closed_unmerged"],
        [950, "open"],
        [951, "open"],
      ]);
    });

    it("warns and keeps the rows when GitHub cannot reach the repository", async () => {
      await fixture
        .db()
        .update(juniorGitHubPullRequests)
        .set({ repositoryId: "2" });
      await heartbeat(now);

      expect(heartbeatLogs).toEqual([
        ["warn", "GitHub pull request reconcile skipped a repository"],
      ]);
      expect(queries).toEqual([]);
      expect(new Set((await rowStates()).map(([, state]) => state))).toEqual(
        new Set(["open"]),
      );
    });

    it("keeps a close open for the next reconcile when its event fails", async () => {
      vi.spyOn(events, "publish").mockRejectedValueOnce(
        new Error("The event queue is down"),
      );
      await heartbeat(now);
      const states = async () =>
        (
          await fixture
            .db()
            .select()
            .from(juniorGitHubPullRequests)
            .orderBy(juniorGitHubPullRequests.number)
        ).map((row) => [row.number, row.state]);
      expect(await states()).toContainEqual([946, "open"]);

      vi.setSystemTime(now + day);
      await heartbeat(now + day);
      expect(await states()).toContainEqual([946, "merged"]);
      expect(
        published.filter(
          (event) =>
            event.identifier === "getsentry/junior#946" &&
            event.eventType === "pull_request.merged",
        ),
      ).toHaveLength(1);
    });
  });
});
