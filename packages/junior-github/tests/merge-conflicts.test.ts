import { createHmac, generateKeyPairSync } from "node:crypto";
import type { EventInput } from "@sentry/junior-plugin-api";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

/** A signed conversation comment on pull request 946. */
function commentRequest(deliveryId: string): Request {
  const body = JSON.stringify({
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
  });
  return new Request("https://example.test/api/webhooks/github", {
    method: "POST",
    headers: {
      "x-github-delivery": deliveryId,
      "x-github-event": "issue_comment",
      "x-hub-signature-256": `sha256=${createHmac("sha256", "test-secret")
        .update(body)
        .digest("hex")}`,
    },
    body,
  });
}

describe("merge conflict check on webhook events", () => {
  let fixture: GitHubFixture;
  let published: EventInput[];
  let pullRequestReads: number;
  let pullRequest: ReturnType<typeof pullRequestResponse>;
  let watchesConflicts: boolean;

  async function deliver(deliveryId: string): Promise<void> {
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
      events: {
        // The Watch made after Junior creates a pull request.
        async hasMatch(event) {
          return (
            event.identifier === "getsentry/junior#946" &&
            (event.eventType !== "pull_request.merge_conflict" ||
              watchesConflicts)
          );
        },
        async publish(event) {
          published.push(event);
        },
      },
      log: { error() {}, info() {}, warn() {} },
      plugin: { name: "github" },
      users: {
        async readIdentity() {
          return undefined;
        },
      },
    });
    const response = await route!.handler(commentRequest(deliveryId));
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
    watchesConflicts = true;
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
});
