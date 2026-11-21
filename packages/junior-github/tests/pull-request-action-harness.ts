/**
 * Shared wiring for the next-action item tests: signed GitHub webhooks,
 * mocked GitHub REST and GraphQL APIs, and the plugin's webhook route.
 */
import { createHmac, generateKeyPairSync } from "node:crypto";
import type {
  PluginConversationReviewItems,
  PluginRoute,
} from "@sentry/junior-plugin-api";
import { bindPluginTool } from "@sentry/junior-testing/plugin-tool";
import { http, HttpResponse } from "msw";
import { vi } from "vitest";
import {
  juniorGitHubPullRequestRequesters,
  juniorGitHubPullRequests,
} from "../src/db/schema";
import { githubPlugin } from "../src/index";
import type { GitHubFixture } from "./github-db";
import { mswServer } from "./msw";

export const PULL_URL = "https://github.com/getsentry/junior/pull/946";
export const DEDUPE_KEY = "pull-request-action:getsentry/junior#946";
const BOT_USER_ID = 264270552;

let delivery = 0;

export function signedRequest(
  body: Record<string, unknown>,
  eventName: string,
) {
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

export const repository = {
  full_name: "getsentry/junior",
  id: 2001,
  name: "junior",
  owner: { login: "getsentry" },
};

export function checkSuiteCompleted() {
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

export function reviewSubmitted(
  state: "approved" | "changes_requested" | "commented",
  by: { at?: string; login: string } = { login: "reviewer" },
) {
  return signedRequest(
    {
      action: "submitted",
      pull_request: { number: 946, user: { login: "sentry-junior[bot]" } },
      repository,
      review: { state, submitted_at: by.at, user: { login: by.login } },
    },
    "pull_request_review",
  );
}

/**
 * A conversation comment, or a review comment reply, on the pull request.
 * GitHub keeps it, as a comment or as a review that holds the reply.
 */
export function commented(
  github: GitHubState,
  eventName: "issue_comment" | "pull_request_review_comment",
  by: { at: string; login: string },
) {
  const comment = {
    body: "Reply",
    created_at: by.at,
    id: delivery + 1,
    user: { login: by.login },
  };
  if (eventName === "issue_comment") {
    (github.comments ??= []).push(by);
  } else {
    github.reviews.push({
      state: "COMMENTED",
      submitted_at: by.at,
      user: { login: by.login },
    });
  }
  return signedRequest(
    eventName === "issue_comment"
      ? {
          action: "created",
          comment,
          issue: { number: 946, pull_request: {} },
          repository,
        }
      : {
          action: "created",
          comment,
          pull_request: { number: 946 },
          repository,
        },
    eventName,
  );
}

/** GitHub asks one person for their review, and shows it on the timeline. */
export function reviewRequested(
  github: GitHubState,
  login: string,
  at: string,
) {
  (github.reviewRequests ??= []).push({ at, login });
  return signedRequest(
    {
      action: "review_requested",
      pull_request: { number: 946, user: { login: "sentry-junior[bot]" } },
      repository,
      requested_reviewer: { login },
      sender: { login: "sentry-junior[bot]" },
    },
    "pull_request",
  );
}

export function pullRequestAction(action: string, merged = false) {
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

/** GitHub state that the mocked REST and GraphQL APIs return. */
export interface GitHubState {
  autoMerge?: boolean | undefined;
  /** Conversation comments on the pull request, oldest first. */
  comments?: Array<{ at: string; login: string }>;
  draft: boolean;
  /** The commit at the head of the pull request. */
  headSha?: string;
  /** Each pull request read takes the next value. The last one repeats. */
  mergeableStates: Array<string | null>;
  /** When set, the next pull request read waits for it. */
  holdNextPullRead?: Promise<void> | undefined;
  merged: boolean;
  requestedReviewers?: string[];
  /** The review requests on the pull request's timeline. */
  reviewRequests?: Array<{ at: string; login: string }>;
  reviews: Array<{
    commit_id?: string;
    id?: number;
    state: string;
    submitted_at?: string;
    user: { login: string };
  }>;
  state: "closed" | "open";
}

// Each pull request read takes the next merge state, after any hold.
async function readPull(github: GitHubState): Promise<string | null> {
  const mergeableState =
    github.mergeableStates.length > 1
      ? github.mergeableStates.shift()
      : github.mergeableStates[0];
  const hold = github.holdNextPullRead;
  github.holdNextPullRead = undefined;
  await hold;
  return mergeableState ?? null;
}

// GraphQL names a bot without the `[bot]` that REST adds.
function graphqlActor(login: string) {
  return login.endsWith("[bot]")
    ? { __typename: "Bot", login: login.slice(0, -"[bot]".length) }
    : { __typename: "User", login };
}

// The 100 reviews before the cursor, oldest first. A cursor is an index.
function reviewsPage(github: GitHubState, before: number) {
  const start = Math.max(0, before - 100);
  return {
    nodes: github.reviews.slice(start, before).map((review) => ({
      author: graphqlActor(review.user.login),
      commit: review.commit_id ? { oid: review.commit_id } : null,
      state: review.state,
      submittedAt: review.submitted_at ?? null,
    })),
    pageInfo: { hasPreviousPage: start > 0, startCursor: String(start) },
  };
}

export function mockGitHub(github: GitHubState, requests: string[]) {
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
        const mergeableState = await readPull(github);
        return HttpResponse.json({
          auto_merge: github.autoMerge
            ? { enabled_by: { login: "someone" }, merge_method: "squash" }
            : null,
          draft: github.draft,
          head: { sha: github.headSha ?? "head-1" },
          html_url: PULL_URL,
          mergeable_state: mergeableState,
          merged: github.merged,
          requested_reviewers: (github.requestedReviewers ?? []).map(
            (login) => ({ login }),
          ),
          state: github.state,
          title: "Add the Inbox notice",
          user: { id: BOT_USER_ID },
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
    // The feedback tool reads one review, and sets its reaction.
    http.get(
      "https://api.github.com/repos/getsentry/junior/pulls/946/reviews/:id",
      ({ params }) => {
        const review = github.reviews.find(
          (item) => item.id === Number(params["id"]),
        );
        return HttpResponse.json({ ...review, node_id: `PRR_${review?.id}` });
      },
    ),
    http.post("https://api.github.com/graphql", async ({ request }) => {
      const { operationName, variables } = (await request.json()) as {
        operationName: string;
        variables: { before?: string };
      };
      if (operationName === "PullRequestNextAction") {
        requests.push("pull");
        const mergeableState = await readPull(github);
        return HttpResponse.json({
          data: {
            repository: {
              pullRequest: {
                autoMergeRequest: github.autoMerge
                  ? { enabledAt: "2026-07-02T00:00:00Z" }
                  : null,
                commits: { nodes: [] },
                headRefOid: github.headSha ?? "head-1",
                isDraft: github.draft,
                mergeStateStatus: (mergeableState ?? "unknown").toUpperCase(),
                reviewRequests: {
                  nodes: (github.requestedReviewers ?? []).map((login) => ({
                    requestedReviewer: { __typename: "User", login },
                  })),
                },
                reviews: reviewsPage(github, github.reviews.length),
                state: github.merged ? "MERGED" : github.state.toUpperCase(),
                timelineItems: {
                  nodes: [
                    // GitHub returns null for a deleted or hidden item.
                    null,
                    ...(github.comments ?? []).map((comment) => ({
                      __typename: "IssueComment",
                      author: graphqlActor(comment.login),
                      createdAt: comment.at,
                    })),
                    ...(github.reviewRequests ?? []).map((event) => ({
                      __typename: "ReviewRequestedEvent",
                      createdAt: event.at,
                      requestedReviewer: {
                        __typename: "User",
                        login: event.login,
                      },
                    })),
                  ],
                },
                title: "Add the Inbox notice",
                url: PULL_URL,
              },
            },
          },
        });
      }
      if (operationName === "PullRequestReviewsBefore") {
        requests.push("reviews");
        return HttpResponse.json({
          data: {
            repository: {
              pullRequest: {
                reviews: reviewsPage(github, Number(variables.before)),
              },
            },
          },
        });
      }
      return HttpResponse.json({ data: { node: { reactionGroups: [] } } });
    }),
    // GitHub asks the reviewers again, as it does for a real request.
    http.post(
      "https://api.github.com/repos/getsentry/junior/pulls/946/requested_reviewers",
      async ({ request }) => {
        const { reviewers } = (await request.json()) as { reviewers: string[] };
        requests.push(`request ${reviewers.join(",")}`);
        github.requestedReviewers = [
          ...(github.requestedReviewers ?? []),
          ...reviewers,
        ];
        return HttpResponse.json({}, { status: 201 });
      },
    ),
  );
}

/** Mark one review body addressed with the feedback tool, as Junior does. */
export async function markReviewAddressed(reviewId: number): Promise<void> {
  const tool = bindPluginTool(
    githubPlugin().hooks!.tools!()["updatePullRequestFeedback"],
    {
      egress: {
        fetch: async ({ request }: { request: Request }) =>
          await fetch(request),
      },
      log: { error() {}, info() {}, warn() {} },
      users: { replaceSlackMentions: async (value: unknown) => value },
    } as never,
  );
  await tool.execute(
    {
      comment_id: reviewId,
      comment_kind: "review_body",
      pull_request: 946,
      repo: "getsentry/junior",
      status: "addressed",
    },
    { toolCallId: `addressed-${reviewId}` },
  );
}

export type ReviewItemCall =
  | { conversationId: string; kind: "upsert"; notice: unknown }
  | { conversationId: string; input: unknown; kind: "close" };

export function route(
  fixture: GitHubFixture,
  calls: ReviewItemCall[],
  errors: string[] = [],
  failures = { close: 0 },
  /** Keys of the other closed items, such as from before one item per pull request. */
  otherCloses: string[] = [],
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
            otherCloses.push(input.dedupeKey);
            return;
          }
          if (failures.close > 0) {
            failures.close -= 1;
            throw new Error("Inbox is down");
          }
          calls.push({ conversationId, input, kind: "close" });
        },
      };
    },
  };
  // These webhooks use no Conversation dispatch, state, or cache.
  const unused = () => {
    throw new Error("The next-action webhooks do not use this");
  };
  const [webhook] = githubPlugin().hooks!.routes!({
    agent: { dispatchForIdentity: unused },
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
    cache: { getOrLoad: unused },
    reviewItems,
    state: {
      delete: unused,
      get: unused,
      set: unused,
      setIfNotExists: unused,
      withLock: unused,
    },
    // The requester linked the GitHub account `Requester`.
    users: {
      readIdentity: async (identityId: string) =>
        identityId === "identity-requester"
          ? {
              identity: {
                id: identityId,
                provider: "slack",
                providerSubjectId: "U123",
              },
              user: {
                email: "requester@example.com",
                id: "user-requester",
                identities: [
                  {
                    handle: "Requester",
                    id: "identity-github",
                    provider: "github",
                    providerSubjectId: "1001",
                  },
                ],
              },
            }
          : undefined,
    },
  });
  if (!webhook) throw new Error("The GitHub plugin has no webhook route");
  return webhook;
}

export async function seedJuniorPullRequest(
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

/** Set the GitHub App environment that the webhook route and tools read. */
export function stubGitHubAppEnv(): void {
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
}
