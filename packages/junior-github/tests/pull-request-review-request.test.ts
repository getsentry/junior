import { createHmac, generateKeyPairSync } from "node:crypto";
import type {
  PluginConversationReviewItems,
  PluginRoute,
} from "@sentry/junior-plugin-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  juniorGitHubPullRequestRequesters,
  juniorGitHubPullRequests,
} from "../src/db/schema";
import { githubPlugin } from "../src/index";
import { createGitHubFixture, type GitHubFixture } from "./github-db";

const CONVERSATION_ID = "slack:C123:1712345.0001";
const PULL_URL = "https://github.com/getsentry/junior/pull/946";
const DEDUPE_KEY = "pull-request-review-requested:getsentry/junior#946";

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
  html_url: PULL_URL,
  id: 1001,
  number: 946,
  title: "Add the review desk ask",
  user: { login: "sentry-junior[bot]" },
};

function reviewRequest(
  action: "review_requested" | "review_request_removed",
  reviewer: { requested_reviewer: { login: string } } | { requested_team: {} },
) {
  return signedRequest(
    { action, pull_request: pullRequest, ...reviewer },
    "pull_request",
  );
}

function reviewSubmitted(login: string) {
  return signedRequest(
    {
      action: "submitted",
      pull_request: pullRequest,
      review: { state: "commented", user: { login } },
    },
    "pull_request_review",
  );
}

type ReviewItemCall =
  | { kind: "upsert"; notice: unknown }
  | { input: unknown; kind: "close" };

function route(fixture: GitHubFixture, calls: ReviewItemCall[]): PluginRoute {
  const reviewItems: PluginConversationReviewItems = {
    forConversation(conversationId) {
      expect(conversationId).toBe(CONVERSATION_ID);
      return {
        async upsert(notice) {
          if (notice.dedupeKey === DEDUPE_KEY) {
            calls.push({ kind: "upsert", notice });
          }
        },
        async close(input) {
          if (input.dedupeKey === DEDUPE_KEY)
            calls.push({ input, kind: "close" });
        },
      };
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
      async record() {},
    },
    db: fixture.db(),
    events: { hasMatch: async () => false, async publish() {} },
    log: { error() {}, info() {}, warn() {} },
    plugin: { name: "github" },
    reviewItems,
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
  return webhook!;
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

describe("review requested ask", () => {
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

  it("waits on the requester from their review request until they review", async () => {
    const fixture = await createGitHubFixture();
    const calls: ReviewItemCall[] = [];
    try {
      await seedJuniorPullRequest(fixture);
      const webhook = route(fixture, calls);
      const ask = {
        kind: "upsert",
        notice: {
          assigneeIdentityIds: ["identity-requester"],
          body: `GitHub asks you to review **Add the review desk ask**: ${PULL_URL}`,
          dedupeKey: DEDUPE_KEY,
          subject: {
            id: PULL_URL,
            title: "getsentry/junior#946",
            url: PULL_URL,
          },
          title: "Review requested · #946",
          waitsOnAssignees: true,
        },
      };

      // Requests for other people or for a team do not wait on the requester.
      await webhook.handler(
        reviewRequest("review_requested", {
          requested_reviewer: { login: "someone-else" },
        }),
      );
      await webhook.handler(
        reviewRequest("review_requested", { requested_team: {} }),
      );
      expect(calls).toEqual([]);

      // The GitHub login matches the requester's linked account in any case.
      await webhook.handler(
        reviewRequest("review_requested", {
          requested_reviewer: { login: "requester" },
        }),
      );
      expect(calls).toEqual([ask]);

      await webhook.handler(reviewSubmitted("someone-else"));
      expect(calls).toEqual([ask]);
      await webhook.handler(reviewSubmitted("Requester"));
      expect(calls.at(-1)).toEqual({
        input: {
          dedupeKey: DEDUPE_KEY,
          reason: "The requester reviewed the pull request.",
          status: "done",
        },
        kind: "close",
      });

      // A new request uses the same key, so the review desk keeps one item.
      await webhook.handler(
        reviewRequest("review_requested", {
          requested_reviewer: { login: "Requester" },
        }),
      );
      expect(calls.at(-1)).toEqual(ask);
      await webhook.handler(
        reviewRequest("review_request_removed", {
          requested_reviewer: { login: "Requester" },
        }),
      );
      expect(calls.at(-1)).toEqual({
        input: {
          dedupeKey: DEDUPE_KEY,
          reason: "The review request was removed.",
          status: "dismissed",
        },
        kind: "close",
      });
      expect(calls).toHaveLength(4);
    } finally {
      await fixture.close();
    }
  });
});
