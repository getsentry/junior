import { createHmac, generateKeyPairSync } from "node:crypto";
import type {
  EventInput,
  EventPublisher,
  HeartbeatHookContext,
} from "@sentry/junior-plugin-api";
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
        async record() {},
      },
      db: fixture.db(),
      events,
      log: { error() {}, info() {}, warn() {} },
      plugin: { name: "github" },
      users: {
        async readIdentity() {
          return undefined;
        },
      },
    });
    const response = await route!.handler(request);
    expect(response.status).toBe(202);
  }

  const conflicts = () =>
    published.filter(
      (event) => event.eventType === "pull_request.merge_conflict",
    );

  beforeEach(async () => {
    fixture = await createGitHubFixture();
    published = [];
    pullRequestReads = 0;
    watchesComments = true;
    watchesConflicts = true;
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
          repository: { full_name: "getsentry/junior" },
          pull_request: {
            ...pullRequestResponse({
              headSha: "3333333333333333333333333333333333333333",
              mergeable: false,
              mergeableState: "dirty",
            }),
            draft: false,
            number: 946,
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

  describe("after a push to the base branch", () => {
    const pushedAt = Date.parse("2026-11-09T12:00:00.000Z");
    const minute = 60_000;

    async function heartbeat(nowMs: number): Promise<void> {
      const unused = () => {
        throw new Error("The GitHub heartbeat does not use this");
      };
      const context: HeartbeatHookContext = {
        agent: { dispatch: unused, get: unused },
        cache: {
          async getOrLoad(_key, load) {
            return (await load()).value;
          },
        },
        db: fixture.db(),
        embedder: { embedTexts: unused, model: "unused", provider: "unused" },
        events,
        log: { error() {}, info() {}, warn() {} },
        nowMs,
        plugin: { name: "github" },
        state: {
          delete: unused,
          get: unused,
          set: unused,
          setIfNotExists: unused,
          withLock: unused,
        },
      };
      await githubPlugin().hooks!.heartbeat!(context);
    }

    function pushRequest(ref: string): Request {
      return signedRequest({
        deliveryId: `push-${ref}`,
        eventName: "push",
        body: {
          installation: { id: 456 },
          ref,
          repository: { full_name: "getsentry/junior" },
        },
      });
    }

    beforeEach(async () => {
      vi.useFakeTimers({ now: pushedAt, toFake: ["Date"] });
      await fixture
        .db()
        .insert(juniorGitHubPullRequests)
        .values({
          baseBranch: "main",
          number: 946,
          openedAt: new Date(pushedAt - 60 * minute),
          pullRequestId: "9460",
          repositoryFullName: "getsentry/junior",
          repositoryId: "1",
          state: "open",
          updatedAt: new Date(pushedAt - 60 * minute),
        });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("publishes a conflict on the heartbeat, with one read for a burst of pushes", async () => {
      await deliver("push-1", pushRequest("refs/heads/main"));
      vi.setSystemTime(pushedAt + minute);
      await deliver("push-2", pushRequest("refs/heads/main"));
      // The push webhook makes no GitHub call.
      expect(pullRequestReads).toBe(0);

      await heartbeat(pushedAt + minute);
      expect(pullRequestReads).toBe(0);

      await heartbeat(pushedAt + 2 * minute);
      expect(pullRequestReads).toBe(1);
      expect(conflicts().map((event) => event.identifier)).toEqual([
        "getsentry/junior#946",
        "getsentry/junior",
      ]);

      await heartbeat(pushedAt + 10 * minute);
      expect(pullRequestReads).toBe(1);
    });

    it("reads again while GitHub calculates mergeability", async () => {
      pullRequest = pullRequestResponse({
        headSha: "1111111111111111111111111111111111111111",
        mergeable: null,
        mergeableState: "unknown",
      });
      await deliver("push-1", pushRequest("refs/heads/main"));
      await heartbeat(pushedAt + 2 * minute);
      expect(pullRequestReads).toBe(1);
      expect(conflicts()).toEqual([]);

      pullRequest = pullRequestResponse({
        headSha: "1111111111111111111111111111111111111111",
        mergeable: false,
        mergeableState: "dirty",
      });
      await heartbeat(pushedAt + 3 * minute);
      expect(pullRequestReads).toBe(2);
      expect(conflicts()).toHaveLength(2);
    });

    it("does not check after a push to another branch", async () => {
      await deliver("push-1", pushRequest("refs/heads/feat/other"));
      await heartbeat(pushedAt + 10 * minute);
      expect(pullRequestReads).toBe(0);
    });

    it("does not read the pull request when nothing wants conflicts", async () => {
      watchesConflicts = false;
      await deliver("push-1", pushRequest("refs/heads/main"));
      await heartbeat(pushedAt + 2 * minute);
      watchesConflicts = true;
      await heartbeat(pushedAt + 10 * minute);
      expect(pullRequestReads).toBe(0);
      expect(conflicts()).toEqual([]);
    });

    it("uses the base branch from a pull request webhook", async () => {
      await deliver(
        "edited-1",
        signedRequest({
          deliveryId: "edited-1",
          eventName: "pull_request",
          body: {
            action: "edited",
            installation: { id: 456 },
            repository: { full_name: "getsentry/junior" },
            pull_request: {
              ...pullRequestResponse({
                headSha: "1111111111111111111111111111111111111111",
                mergeable: true,
                mergeableState: "clean",
              }),
              base: { ref: "release/1.0" },
              draft: false,
              id: 9460,
              number: 946,
              user: { login: "jane" },
            },
          },
        }),
      );
      await deliver("push-1", pushRequest("refs/heads/main"));
      await heartbeat(pushedAt + 10 * minute);
      expect(pullRequestReads).toBe(0);

      await deliver("push-2", pushRequest("refs/heads/release/1.0"));
      await heartbeat(pushedAt + 20 * minute);
      expect(pullRequestReads).toBe(1);
    });
  });
});
