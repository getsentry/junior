import { bindPluginTool } from "@sentry/junior-testing/plugin-tool";
import { createHmac, generateKeyPairSync } from "node:crypto";
import type {
  PluginConversationReviewItems,
  PluginRoute,
  PluginState,
} from "@sentry/junior-plugin-api";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  juniorGitHubPullRequestRequesters,
  juniorGitHubPullRequests,
} from "../src/db/schema";
import { githubPlugin } from "../src/index";
import { recordGitHubPullRequestRequester } from "../src/pull-request-requesters/store";
import { createGitHubFixture, type GitHubFixture } from "./github-db";
import { mswServer } from "./msw";

const CONVERSATION_ID = "slack:C123:1712345.0001";
const PULL_URL = "https://github.com/getsentry/junior/pull/946";

let delivery = 0;

function signedRequest(body: Record<string, unknown>, eventName: string) {
  const rawBody = JSON.stringify({
    installation: { id: 456 },
    repository: {
      full_name: "getsentry/junior",
      id: 2001,
      name: "junior",
      owner: { login: "getsentry" },
    },
    ...body,
  });
  const signature = `sha256=${createHmac("sha256", "test-secret")
    .update(rawBody)
    .digest("hex")}`;
  delivery += 1;
  return new Request("https://example.test/api/webhooks/github", {
    method: "POST",
    headers: {
      "x-github-delivery": `review-request-${delivery}`,
      "x-github-event": eventName,
      "x-hub-signature-256": signature,
    },
    body: rawBody,
  });
}

const pullRequest = {
  created_at: "2026-07-01T12:00:00Z",
  html_url: PULL_URL,
  id: 1001,
  merged: false,
  number: 946,
  title: "Add the review desk ask",
  updated_at: "2026-07-01T12:00:00Z",
  user: { login: "sentry-junior[bot]" },
};

/** Plugin state that the tool and the webhook share. */
function memoryState(): PluginState {
  const values = new Map<string, unknown>();
  return {
    async delete(key) {
      values.delete(key);
    },
    async get<T>(key: string) {
      return values.get(key) as T | undefined;
    },
    async set(key, value) {
      values.set(key, value);
    },
    async setIfNotExists(key, value) {
      if (values.has(key)) return false;
      values.set(key, value);
      return true;
    },
    async withLock(_key, _ttlMs, callback) {
      return await callback();
    },
  };
}

function route(
  fixture: GitHubFixture,
  options: { state?: PluginState; warnings?: string[] } = {},
): PluginRoute {
  // The next-action item has its own tests.
  const reviewItems: PluginConversationReviewItems = {
    forConversation() {
      return { async upsert() {}, async close() {} };
    },
  };
  const [webhook] = githubPlugin().hooks!.routes!({
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
    codeChanges: {
      async associateConversations() {},
      async recordActivity() {},
      async record() {},
    },
    db: fixture.db(),
    events: { hasMatch: async () => false, async publish() {} },
    log: {
      error() {},
      info() {},
      warn: (message: string) => options.warnings?.push(message),
    },
    plugin: { name: "github" },
    reviewItems,
    state: options.state ?? memoryState(),
    // The requester linked the GitHub account `Requester`.
    users: {
      readIdentity: async (identityId: string) =>
        identityId === "identity-requester"
          ? {
              identity: { id: identityId },
              user: {
                identities: [{ handle: "Requester", provider: "github" }],
              },
            }
          : undefined,
    },
  } as never);
  return webhook;
}

async function seedJuniorPullRequest(fixture: GitHubFixture): Promise<void> {
  const at = new Date("2026-07-01T12:00:00.000Z");
  await fixture
    .db()
    .insert(juniorGitHubPullRequests)
    .values({
      conversationIds: [CONVERSATION_ID],
      number: 946,
      openedAt: at,
      pullRequestId: "1001",
      repositoryFullName: "getsentry/junior",
      repositoryId: "2001",
      state: "open",
      updatedAt: at,
    });
  await fixture.db().insert(juniorGitHubPullRequestRequesters).values({
    conversationId: CONVERSATION_ID,
    createdAt: at,
    identityId: "identity-requester",
    number: 946,
    repositoryFullName: "getsentry/junior",
    updatedAt: at,
  });
}

describe("review request when a draft is ready", () => {
  beforeEach(() => {
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    vi.stubEnv("GITHUB_APP_ID", "123");
    vi.stubEnv("GITHUB_INSTALLATION_ID", "456");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", privateKey);
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "test-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** Open a draft through the tool, as the requester asked in Slack. */
  async function createDraft(
    fixture: GitHubFixture,
    state: PluginState,
    reviewers?: string[],
  ): Promise<string[]> {
    const operations: string[] = [];
    const tool = bindPluginTool(
      githubPlugin().hooks!.tools!().createPullRequest,
      {
        actor: { platform: "slack", teamId: "T1", userId: "U1" },
        conversationId: CONVERSATION_ID,
        db: fixture.db(),
        destination: { platform: "local", conversationId: CONVERSATION_ID },
        egress: {
          async fetch({ operation }: { operation: string }) {
            operations.push(operation);
            return operation === "github.pull.create"
              ? Response.json(
                  { draft: true, html_url: PULL_URL, number: 946 },
                  { status: 201 },
                )
              : Response.json({});
          },
        },
        events: { canSubscribe: false, async subscribe() {} },
        log: { error() {}, info() {}, warn() {} },
        plugin: { name: "github" },
        state,
        users: {
          replaceSlackMentions: async (value: unknown) => value,
          resolveActor: async () => ({
            identity: { id: "identity-requester", provider: "slack" },
            user: { identities: [{ handle: "Requester", provider: "github" }] },
          }),
        },
      } as never,
    );
    await tool.execute(
      {
        base: "main",
        draft: true,
        head: "feat/review-desk-ask",
        repo: "getsentry/junior",
        title: pullRequest.title,
        ...(reviewers ? { reviewers } : undefined),
      },
      { toolCallId: `call-${reviewers?.join("-") ?? "requester"}` },
    );
    return operations;
  }

  function readyForReview() {
    return signedRequest(
      {
        action: "ready_for_review",
        pull_request: {
          ...pullRequest,
          draft: false,
          head: { ref: "feat/review-desk-ask" },
          state: "open",
        },
      },
      "pull_request",
    );
  }

  /** Serve the ready webhook's GitHub calls and record each review request. */
  function serveReviewRequests(status = 201): unknown[] {
    const requests: unknown[] = [];
    mswServer.use(
      http.post(
        "https://api.github.com/app/installations/456/access_tokens",
        () =>
          HttpResponse.json({
            expires_at: "2027-01-01T00:00:00.000Z",
            token: "installation-token",
          }),
      ),
      http.get("https://api.github.com/repos/getsentry/junior/pulls/946", () =>
        HttpResponse.json({ draft: false, html_url: PULL_URL, number: 946 }),
      ),
      http.post(
        "https://api.github.com/repos/getsentry/junior/pulls/946/requested_reviewers",
        async ({ request }) => {
          requests.push(await request.json());
          return HttpResponse.json({}, { status });
        },
      ),
    );
    return requests;
  }

  it.each([
    { expected: ["Requester"], name: "the requester", reviewers: undefined },
    {
      expected: ["octocat"],
      name: "the named reviewers",
      reviewers: ["octocat"],
    },
  ])(
    "asks $name to review a draft only when it becomes ready",
    async ({ expected, reviewers }) => {
      const fixture = await createGitHubFixture();
      const requests = serveReviewRequests();
      try {
        const state = memoryState();
        const operations = await createDraft(fixture, state, reviewers);
        expect(operations).not.toContain("github.pull.request_reviewers");

        const response = await route(fixture, { state }).handler(
          readyForReview(),
        );
        expect(response.status).toBe(202);
        expect(requests).toEqual([{ reviewers: expected }]);
      } finally {
        await fixture.close();
      }
    },
  );

  it("keeps the named reviewers when a draft create call is replayed", async () => {
    const fixture = await createGitHubFixture();
    const requests = serveReviewRequests();
    try {
      // The first call stops before it saves the named reviewers.
      const state = memoryState();
      const set = state.set.bind(state);
      let dropped = false;
      state.set = async (key, value, ttlMs) => {
        if (!dropped && key.startsWith("pull-request-draft-reviewers:")) {
          dropped = true;
          throw new Error("state write failed");
        }
        await set(key, value, ttlMs);
      };
      await createDraft(fixture, state, ["octocat"]);
      await createDraft(fixture, state, ["octocat"]);

      await route(fixture, { state }).handler(readyForReview());
      expect(requests).toEqual([{ reviewers: ["octocat"] }]);
    } finally {
      await fixture.close();
    }
  });

  it("does not ask for a review of a pull request that Junior only updated", async () => {
    const fixture = await createGitHubFixture();
    const requests = serveReviewRequests();
    try {
      await recordGitHubPullRequestRequester(fixture.db(), {
        identityId: "identity-requester",
        number: 946,
        repositoryFullName: "getsentry/junior",
      });

      const response = await route(fixture).handler(readyForReview());
      expect(response.status).toBe(202);
      expect(requests).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("keeps the delivery when GitHub rejects the review request", async () => {
    const fixture = await createGitHubFixture();
    serveReviewRequests(422);
    try {
      await seedJuniorPullRequest(fixture);
      const warnings: string[] = [];
      const response = await route(fixture, { warnings }).handler(
        readyForReview(),
      );
      expect(response.status).toBe(202);
      expect(warnings).toEqual(["GitHub pull request review request failed"]);
    } finally {
      await fixture.close();
    }
  });
});
