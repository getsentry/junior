import { createHmac, generateKeyPairSync } from "node:crypto";
import type {
  PluginConversationReviewItems,
  PluginRoute,
} from "@sentry/junior-plugin-api";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  juniorGitHubPullRequestRequesters,
  juniorGitHubPullRequests,
} from "../src/db/schema";
import { githubPlugin } from "../src/index";
import { createGitHubFixture, type GitHubFixture } from "./github-db";
import { mswServer } from "./msw";

const PULL_URL = "https://github.com/getsentry/junior/pull/946";
const DEDUPE_KEY = "pull-request-ready:getsentry/junior#946";

let delivery = 0;

function signedRequest(body: Record<string, unknown>, eventName: string) {
  const rawBody = JSON.stringify({ installation: { id: 456 }, ...body });
  const signature = `sha256=${createHmac("sha256", "test-secret")
    .update(rawBody)
    .digest("hex")}`;
  delivery += 1;
  return new Request("https://example.test/api/webhooks/github", {
    method: "POST",
    headers: {
      "x-github-delivery": `delivery-${delivery}`,
      "x-github-event": eventName,
      "x-hub-signature-256": signature,
    },
    body: rawBody,
  });
}

const repository = {
  full_name: "getsentry/junior",
  id: 2001,
  name: "junior",
  owner: { login: "getsentry" },
};

function checkSuiteCompleted() {
  return signedRequest(
    {
      action: "completed",
      check_suite: {
        conclusion: "success",
        head_sha: "abcdef1234567890",
        id: 77,
        pull_requests: [
          {
            base: { repo: { id: 2001, name: "junior", url: "u" } },
            number: 946,
          },
        ],
      },
      repository,
    },
    "check_suite",
  );
}

function reviewSubmitted(state: "approved" | "changes_requested") {
  return signedRequest(
    {
      action: "submitted",
      pull_request: { number: 946, user: { login: "sentry-junior[bot]" } },
      repository,
      review: { state, user: { login: "reviewer" } },
    },
    "pull_request_review",
  );
}

function pullRequestAction(action: string, merged = false) {
  return signedRequest(
    {
      action,
      pull_request: {
        body: "Implemented by Junior",
        closed_at: action === "closed" ? "2026-07-03T12:00:00.000Z" : null,
        created_at: "2026-07-01T12:00:00.000Z",
        id: 1001,
        merged,
        merged_at: merged ? "2026-07-03T12:00:00.000Z" : null,
        number: 946,
        updated_at: "2026-07-03T12:00:00.000Z",
        user: { login: "sentry-junior[bot]" },
      },
      repository,
      sender: { login: "someone" },
    },
    "pull_request",
  );
}

/** GitHub state that the mocked REST API returns. */
interface GitHubState {
  draft: boolean;
  /** Each pull request read takes the next value. The last one repeats. */
  mergeableStates: Array<string | null>;
  /** When set, the next pull request read waits for it. */
  holdNextPullRead?: Promise<void>;
  merged: boolean;
  reviews: Array<{ state: string; user: { login: string } }>;
  state: "closed" | "open";
}

function mockGitHub(github: GitHubState, requests: string[]) {
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
        requests.push("pull");
        const mergeableState =
          github.mergeableStates.length > 1
            ? github.mergeableStates.shift()
            : github.mergeableStates[0];
        const hold = github.holdNextPullRead;
        github.holdNextPullRead = undefined;
        await hold;
        return HttpResponse.json({
          draft: github.draft,
          html_url: PULL_URL,
          mergeable_state: mergeableState,
          merged: github.merged,
          state: github.state,
          title: "Add the review desk notice",
        });
      },
    ),
    // The merge webhook also classifies the commits.
    http.get(
      "https://api.github.com/repos/getsentry/junior/pulls/946/commits",
      () => HttpResponse.json([]),
    ),
    http.get(
      "https://api.github.com/repos/getsentry/junior/pulls/946/reviews",
      () => {
        requests.push("reviews");
        return HttpResponse.json(github.reviews);
      },
    ),
  );
}

type ReviewItemCall =
  | { conversationId: string; kind: "upsert"; notice: unknown }
  | { conversationId: string; input: unknown; kind: "close" };

function route(
  fixture: GitHubFixture,
  calls: ReviewItemCall[],
  errors: string[] = [],
  failures = { close: 0 },
): PluginRoute {
  const reviewItems: PluginConversationReviewItems = {
    forConversation(conversationId) {
      return {
        async upsert(notice) {
          calls.push({ conversationId, kind: "upsert", notice });
        },
        async close(input) {
          if (failures.close > 0) {
            failures.close -= 1;
            throw new Error("review desk is down");
          }
          calls.push({ conversationId, input, kind: "close" });
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
    log: {
      error(message) {
        errors.push(message);
      },
      info() {},
      warn() {},
    },
    plugin: { name: "github" },
    events: { hasMatch: async () => false, async publish() {} },
    reviewItems,
  });
  return webhook!;
}

async function seedJuniorPullRequest(
  fixture: GitHubFixture,
  conversationId: string | null,
): Promise<void> {
  const at = new Date("2026-07-01T12:00:00.000Z");
  await fixture
    .db()
    .insert(juniorGitHubPullRequests)
    .values({
      conversationIds: ["slack:C123:1712345.0001"],
      number: 946,
      openedAt: at,
      pullRequestId: "1001",
      repositoryFullName: "getsentry/junior",
      repositoryId: "2001",
      state: "open",
      updatedAt: at,
    });
  await fixture.db().insert(juniorGitHubPullRequestRequesters).values({
    conversationId,
    createdAt: at,
    identityId: "identity-requester",
    number: 946,
    repositoryFullName: "getsentry/junior",
    updatedAt: at,
  });
}

describe("ready to merge notice", () => {
  beforeEach(() => {
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    vi.stubEnv("GITHUB_APP_ID", "123");
    vi.stubEnv("GITHUB_INSTALLATION_ID", "456");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", privateKey);
    vi.stubEnv(
      "GITHUB_APP_BOT_EMAIL",
      "264270552+sentry-junior[bot]@users.noreply.github.com",
    );
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "test-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("adds one notice for the requester while the pull request is ready, and closes it when that stops", async () => {
    const fixture = await createGitHubFixture();
    const calls: ReviewItemCall[] = [];
    const errors: string[] = [];
    const failures = { close: 0 };
    const requests: string[] = [];
    const github: GitHubState = {
      draft: false,
      mergeableStates: ["clean"],
      merged: false,
      reviews: [],
      state: "open",
    };
    mockGitHub(github, requests);
    try {
      await seedJuniorPullRequest(fixture, "slack:C123:1712345.0001");
      const webhook = route(fixture, calls, errors, failures);

      // GitHub can merge it, but no one approved it yet.
      await webhook.handler(checkSuiteCompleted());
      expect(calls).toEqual([]);
      expect(requests).toEqual(["pull", "reviews"]);

      github.reviews = [
        { state: "CHANGES_REQUESTED", user: { login: "reviewer" } },
        { state: "COMMENTED", user: { login: "reviewer" } },
        { state: "APPROVED", user: { login: "Reviewer" } },
      ];
      await webhook.handler(reviewSubmitted("approved"));
      const notice = {
        conversationId: "slack:C123:1712345.0001",
        kind: "upsert",
        notice: {
          assigneeIdentityIds: ["identity-requester"],
          body: `**Add the review desk notice** is approved, and GitHub says that it can merge. Merge it, or say why not: ${PULL_URL}`,
          dedupeKey: DEDUPE_KEY,
          subject: {
            id: PULL_URL,
            title: "getsentry/junior#946",
            url: PULL_URL,
          },
          title: "Ready to merge: getsentry/junior#946",
        },
      };
      expect(calls).toEqual([notice]);

      // Repeat events while it stays ready add nothing.
      await webhook.handler(checkSuiteCompleted());
      await webhook.handler(reviewSubmitted("approved"));
      expect(calls).toEqual([notice]);

      // GitHub has not computed the merge state after a push. Two reads
      // stay unknown, so nothing changes, and a later event decides.
      requests.length = 0;
      github.mergeableStates = [null, "unknown"];
      await webhook.handler(pullRequestAction("synchronize"));
      expect(requests).toEqual(["pull", "pull"]);
      expect(calls).toEqual([notice]);

      // The second read has the merge state: the new checks still run.
      github.mergeableStates = ["unknown", "blocked"];
      await webhook.handler(checkSuiteCompleted());
      expect(calls.at(-1)).toEqual({
        conversationId: "slack:C123:1712345.0001",
        input: {
          dedupeKey: DEDUPE_KEY,
          reason: "The pull request is no longer ready to merge.",
          status: "dismissed",
        },
        kind: "close",
      });

      // Two webhooks run at the same time. The first reads "clean", but its
      // read is slow. The second reads "blocked". The second waits for the
      // first, so the notice ends closed, as GitHub's latest state says.
      let release!: () => void;
      github.holdNextPullRead = new Promise((resolve) => {
        release = resolve;
      });
      github.mergeableStates = ["clean", "blocked"];
      const slow = webhook.handler(checkSuiteCompleted());
      const fast = webhook.handler(checkSuiteCompleted());
      await new Promise((resolve) => setTimeout(resolve, 100));
      release();
      await Promise.all([slow, fast]);
      expect(calls.slice(-2).map((call) => call.kind)).toEqual([
        "upsert",
        "close",
      ]);

      github.mergeableStates = ["clean"];
      await webhook.handler(checkSuiteCompleted());
      expect(calls.at(-1)).toEqual(notice);

      github.merged = true;
      github.state = "closed";
      // The close fails once. A webhook that arrives during the failed
      // check is not lost: the check runs again and closes the notice.
      failures.close = 1;
      let releaseMerge!: () => void;
      github.holdNextPullRead = new Promise((resolve) => {
        releaseMerge = resolve;
      });
      const failing = webhook.handler(pullRequestAction("closed", true));
      const queued = webhook.handler(pullRequestAction("closed", true));
      await new Promise((resolve) => setTimeout(resolve, 100));
      releaseMerge();
      await Promise.all([failing, queued]);
      expect(errors).toEqual(["GitHub pull request ready notice failed"]);
      expect(calls.at(-1)).toEqual({
        conversationId: "slack:C123:1712345.0001",
        input: {
          dedupeKey: DEDUPE_KEY,
          reason: "The pull request merged.",
          status: "done",
        },
        kind: "close",
      });
      expect(calls.map((call) => call.kind)).toEqual([
        "upsert",
        "close",
        "upsert",
        "close",
        "upsert",
        "close",
      ]);
      expect(errors).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("reads nothing from GitHub for a pull request with no requester Conversation", async () => {
    const fixture = await createGitHubFixture();
    const calls: ReviewItemCall[] = [];
    const requests: string[] = [];
    mockGitHub(
      {
        draft: false,
        mergeableStates: ["clean"],
        merged: false,
        reviews: [{ state: "APPROVED", user: { login: "reviewer" } }],
        state: "open",
      },
      requests,
    );
    try {
      await seedJuniorPullRequest(fixture, null);
      await route(fixture, calls).handler(reviewSubmitted("approved"));
      expect(requests).toEqual([]);
      expect(calls).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});
