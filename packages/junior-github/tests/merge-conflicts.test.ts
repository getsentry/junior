import { generateKeyPairSync } from "node:crypto";
import type {
  EventInput,
  HeartbeatHookContext,
  PluginState,
} from "@sentry/junior-plugin-api";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { juniorGitHubPullRequests } from "../src/db/schema";
import { githubPlugin } from "../src/index";
import { createGitHubFixture, type GitHubFixture } from "./github-db";
import { mswServer } from "./msw";

/** In-memory plugin state. TTLs advance with the fake clock. */
function memoryState(): PluginState {
  const values = new Map<string, { expiresAtMs?: number; value: unknown }>();
  const read = (key: string) => {
    const entry = values.get(key);
    if (entry?.expiresAtMs !== undefined && entry.expiresAtMs <= Date.now()) {
      values.delete(key);
      return undefined;
    }
    return entry;
  };
  const write = (key: string, value: unknown, ttlMs?: number) => {
    values.set(key, {
      value,
      ...(ttlMs ? { expiresAtMs: Date.now() + ttlMs } : undefined),
    });
  };
  return {
    async delete(key) {
      values.delete(key);
    },
    async get<T>(key: string) {
      return read(key)?.value as T | undefined;
    },
    async set(key, value, ttlMs) {
      write(key, value, ttlMs);
    },
    async setIfNotExists(key, value, ttlMs) {
      if (read(key)) return false;
      write(key, value, ttlMs);
      return true;
    },
    async withLock(_key, _ttlMs, callback) {
      return await callback();
    },
  };
}

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

describe("merge conflict heartbeat", () => {
  let fixture: GitHubFixture;
  let published: EventInput[];
  let pullRequestReads: string[];
  let pullRequest: ReturnType<typeof pullRequestResponse>;
  let state: PluginState;
  let watched: Set<string>;

  function heartbeatContext(): HeartbeatHookContext {
    return {
      agent: {
        async dispatch() {
          throw new Error("Unexpected dispatch");
        },
        async get() {
          return undefined;
        },
      },
      cache: {
        async getOrLoad(_key, load) {
          return (await load()).value;
        },
      },
      db: fixture.db(),
      events: {
        async hasMatch(event) {
          return (
            event.eventType === "pull_request.merge_conflict" &&
            watched.has(event.identifier)
          );
        },
        async publish(event) {
          published.push(event);
        },
      },
      log: { error() {}, info() {}, warn() {} },
      nowMs: Date.now(),
      plugin: { name: "github" },
      state,
    };
  }

  async function runHeartbeat(): Promise<void> {
    await githubPlugin().hooks!.heartbeat!(heartbeatContext());
  }

  beforeEach(async () => {
    vi.useFakeTimers({ now: Date.parse("2026-07-02T12:00:00.000Z") });
    fixture = await createGitHubFixture();
    published = [];
    pullRequestReads = [];
    state = memoryState();
    watched = new Set(["getsentry/junior#946"]);
    pullRequest = pullRequestResponse({
      headSha: "1111111111111111111111111111111111111111",
      mergeable: true,
      mergeableState: "clean",
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
        "https://api.github.com/repos/getsentry/junior/pulls/:number",
        ({ params }) => {
          pullRequestReads.push(String(params.number));
          return HttpResponse.json(pullRequest);
        },
      ),
    );
    const at = new Date("2026-07-01T12:00:00.000Z");
    await fixture
      .db()
      .insert(juniorGitHubPullRequests)
      .values([
        {
          pullRequestId: "watched-pr",
          repositoryId: "2001",
          repositoryFullName: "getsentry/junior",
          number: 946,
          state: "open",
          conversationIds: ["slack:C123:1712345.0001"],
          openedAt: at,
          updatedAt: at,
        },
        {
          pullRequestId: "unwatched-pr",
          repositoryId: "2001",
          repositoryFullName: "getsentry/junior",
          number: 947,
          state: "open",
          openedAt: at,
          updatedAt: at,
        },
        {
          pullRequestId: "merged-pr",
          repositoryId: "2001",
          repositoryFullName: "getsentry/junior",
          number: 948,
          state: "merged",
          openedAt: at,
          mergedAt: at,
          updatedAt: at,
        },
      ]);
  });

  afterEach(async () => {
    await fixture.close();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("publishes once when the base branch moves under an idle watched pull request", async () => {
    // The pull request merges cleanly. Only the watched pull request is read.
    await runHeartbeat();
    expect(pullRequestReads).toEqual(["946"]);
    expect(published).toEqual([]);

    // The base branch moves and GitHub reports a conflict. Checks wait for
    // the check interval, because the heartbeat runs each minute.
    pullRequest = pullRequestResponse({
      headSha: "1111111111111111111111111111111111111111",
      mergeable: false,
      mergeableState: "dirty",
    });
    vi.advanceTimersByTime(60_000);
    await runHeartbeat();
    expect(pullRequestReads).toEqual(["946"]);

    vi.advanceTimersByTime(5 * 60_000);
    await runHeartbeat();
    expect(published).toEqual([
      expect.objectContaining({
        eventKey:
          "github:merge-conflict:getsentry/junior#946:1111111111111111111111111111111111111111",
        eventType: "pull_request.merge_conflict",
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
      expect.objectContaining({
        eventType: "pull_request.merge_conflict",
        identifier: "getsentry/junior",
      }),
    ]);

    // The same head stays conflicted, so no new event.
    vi.advanceTimersByTime(5 * 60_000);
    await runHeartbeat();
    expect(published).toHaveLength(2);

    // Junior merges the base branch, and the base branch moves again.
    pullRequest = pullRequestResponse({
      headSha: "2222222222222222222222222222222222222222",
      mergeable: false,
      mergeableState: "dirty",
    });
    vi.advanceTimersByTime(5 * 60_000);
    await runHeartbeat();
    expect(published).toHaveLength(4);
    expect(published[2]).toMatchObject({
      data: { headSha: "2222222222222222222222222222222222222222" },
    });
  });

  it("reads every watched pull request when more are watched than one check reads", async () => {
    const at = new Date("2026-07-03T12:00:00.000Z");
    const busy = Array.from({ length: 20 }, (_, index) => ({
      pullRequestId: `busy-${String(index).padStart(2, "0")}`,
      repositoryId: "2001",
      repositoryFullName: "getsentry/junior",
      number: 1000 + index,
      state: "open" as const,
      openedAt: at,
      updatedAt: at,
    }));
    await fixture.db().insert(juniorGitHubPullRequests).values(busy);
    for (const row of busy) watched.add(`getsentry/junior#${row.number}`);

    await runHeartbeat();
    expect(pullRequestReads).toHaveLength(20);
    expect(pullRequestReads).not.toContain("946");

    // The next check goes on after the last pull request it looked at.
    vi.advanceTimersByTime(5 * 60_000);
    await runHeartbeat();
    expect(pullRequestReads.slice(20)).toEqual(["946"]);

    // Then it starts again from the first one.
    vi.advanceTimersByTime(5 * 60_000);
    await runHeartbeat();
    expect(pullRequestReads.slice(21)).toHaveLength(20);
  });

  it("waits while GitHub calculates mergeability", async () => {
    pullRequest = pullRequestResponse({
      headSha: "1111111111111111111111111111111111111111",
      mergeable: null,
      mergeableState: "unknown",
    });
    await runHeartbeat();
    expect(pullRequestReads).toEqual(["946"]);
    expect(published).toEqual([]);
  });

  it("does not read pull requests that nothing watches", async () => {
    watched.clear();
    await runHeartbeat();
    expect(pullRequestReads).toEqual([]);
  });
});
