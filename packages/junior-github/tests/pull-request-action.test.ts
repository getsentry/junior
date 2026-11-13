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
const DEDUPE_KEY = "pull-request-action:getsentry/junior#946";

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
  autoMerge?: boolean;
  draft: boolean;
  /** Each pull request read takes the next value. The last one repeats. */
  mergeableStates: Array<string | null>;
  /** When set, the next pull request read waits for it. */
  holdNextPullRead?: Promise<void>;
  merged: boolean;
  requestedReviewers?: string[];
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
          auto_merge: github.autoMerge
            ? { enabled_by: { login: "someone" }, merge_method: "squash" }
            : null,
          draft: github.draft,
          html_url: PULL_URL,
          mergeable_state: mergeableState,
          merged: github.merged,
          requested_reviewers: (github.requestedReviewers ?? []).map(
            (login) => ({ login }),
          ),
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
      ({ request }) => {
        requests.push("reviews");
        const page = Number(new URL(request.url).searchParams.get("page"));
        return HttpResponse.json(
          github.reviews.slice((page - 1) * 100, page * 100),
        );
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
  /** Keys of the closed items from before one item per pull request. */
  legacyCloses: string[] = [],
): PluginRoute {
  const isReady = (dedupeKey: string) => dedupeKey === DEDUPE_KEY;
  const reviewItems: PluginConversationReviewItems = {
    forConversation(conversationId) {
      return {
        async upsert(notice) {
          if (!isReady(notice.dedupeKey)) return;
          calls.push({ conversationId, kind: "upsert", notice });
        },
        async close(input) {
          if (!isReady(input.dedupeKey)) {
            legacyCloses.push(input.dedupeKey);
            return;
          }
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
      async recordActivity() {},
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

describe("next action item", () => {
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

      // The approval is on the second page of reviews.
      github.reviews = [
        { state: "CHANGES_REQUESTED", user: { login: "reviewer" } },
        ...Array.from({ length: 100 }, () => ({
          state: "COMMENTED",
          user: { login: "reviewer" },
        })),
        { state: "APPROVED", user: { login: "Reviewer" } },
      ];
      await webhook.handler(reviewSubmitted("approved"));
      const notice = {
        conversationId: "slack:C123:1712345.0001",
        kind: "upsert",
        notice: {
          assigneeIdentityIds: ["identity-requester"],
          body: `#946 is approved, and GitHub says that it can merge.\n\n${PULL_URL}`,
          dedupeKey: DEDUPE_KEY,
          subject: {
            id: PULL_URL,
            title: "Add the review desk notice (#946)",
            url: PULL_URL,
          },
          title: "Ready to merge · #946",
          // The merge is the requester's step, so the item waits on them.
          waitsOnAssignees: true,
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

      // With auto-merge on, GitHub merges it, so the notice closes and no
      // reviews load. Turning auto-merge off brings the notice back.
      github.autoMerge = true;
      requests.length = 0;
      await webhook.handler(pullRequestAction("auto_merge_enabled"));
      expect(requests).toEqual(["pull"]);
      expect(calls.at(-1)).toEqual({
        conversationId: "slack:C123:1712345.0001",
        input: {
          dedupeKey: DEDUPE_KEY,
          reason: "Auto-merge is on.",
          status: "dismissed",
        },
        kind: "close",
      });
      github.autoMerge = false;
      await webhook.handler(pullRequestAction("auto_merge_disabled"));
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
      expect(errors).toEqual(["GitHub pull request action failed"]);
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
        "upsert",
        "close",
      ]);
      expect(errors).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("shows one item that changes from review to merge", async () => {
    const fixture = await createGitHubFixture();
    const calls: ReviewItemCall[] = [];
    const github: GitHubState = {
      draft: false,
      mergeableStates: ["blocked"],
      merged: false,
      // Requests for other people or for a team do not wait on the requester.
      requestedReviewers: ["someone-else"],
      reviews: [],
      state: "open",
    };
    mockGitHub(github, []);
    try {
      await seedJuniorPullRequest(fixture, "slack:C123:1712345.0001");
      const legacyCloses: string[] = [];
      const webhook = route(fixture, calls, [], { close: 0 }, legacyCloses);
      await webhook.handler(pullRequestAction("review_requested"));
      expect(calls).toEqual([]);
      // Each check closes the items from before one item per pull request.
      expect(legacyCloses).toEqual([
        "pull-request-ready:getsentry/junior#946",
        "pull-request-review-requested:getsentry/junior#946",
      ]);

      // The GitHub login matches the requester's linked account in any case.
      // A new pull request often has no merge state yet, and the review ask
      // does not wait for it.
      github.requestedReviewers = ["requester"];
      github.mergeableStates = [null];
      await webhook.handler(pullRequestAction("review_requested"));
      const review = {
        conversationId: "slack:C123:1712345.0001",
        kind: "upsert",
        notice: {
          assigneeIdentityIds: ["identity-requester"],
          body: `GitHub asks you to review #946.\n\n${PULL_URL}`,
          dedupeKey: DEDUPE_KEY,
          subject: {
            id: PULL_URL,
            title: "Add the review desk notice (#946)",
            url: PULL_URL,
          },
          title: "Review requested · #946",
          waitsOnAssignees: true,
        },
      };
      expect(calls).toEqual([review]);

      github.requestedReviewers = [];
      github.mergeableStates = ["blocked"];
      await webhook.handler(pullRequestAction("review_request_removed"));
      expect(calls.at(-1)).toEqual({
        conversationId: "slack:C123:1712345.0001",
        input: {
          dedupeKey: DEDUPE_KEY,
          reason: "The review request ended.",
          status: "done",
        },
        kind: "close",
      });

      // GitHub does not send a new request on reopen. The reopen reads the
      // reviewers that are still requested.
      github.requestedReviewers = ["Requester"];
      await webhook.handler(pullRequestAction("reopened"));
      expect(calls.at(-1)).toEqual(review);

      // Someone else approves, and GitHub can merge it. The requester merges
      // or reviews, not both, so the same item now asks for the merge.
      github.mergeableStates = ["clean"];
      github.reviews = [{ state: "APPROVED", user: { login: "someone-else" } }];
      await webhook.handler(reviewSubmitted("approved"));
      expect(calls.at(-1)).toMatchObject({
        kind: "upsert",
        notice: { dedupeKey: DEDUPE_KEY, title: "Ready to merge · #946" },
      });
      expect(calls).toHaveLength(4);
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
