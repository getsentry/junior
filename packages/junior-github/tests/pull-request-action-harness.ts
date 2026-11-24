/**
 * Shared wiring for the next-action item tests: signed GitHub webhooks,
 * mocked GitHub REST and GraphQL APIs, and the plugin's webhook route.
 */
import { createHmac, generateKeyPairSync } from "node:crypto";
import type {
  PluginConversationAnnotations,
  PluginConversationInboxItems,
  PluginReviewNotice,
  PluginRoute,
  PluginState,
} from "@sentry/junior-plugin-api";
import { bindPluginTool } from "@sentry/junior-testing/plugin-tool";
import { http, HttpResponse } from "msw";
import { vi } from "vitest";
import {
  juniorGitHubPullRequestRequesters,
  juniorGitHubPullRequests,
} from "../src/db/schema";
import { githubPlugin } from "../src/index";
import { conversationChangesThrough } from "./conversation-changes";
import type { GitHubFixture } from "./github-db";
import { mswServer } from "./msw";
import { memoryState } from "./plugin-harness";

export const PULL_URL = "https://github.com/getsentry/junior/pull/946";
/** The subject of the pull request's item: GitHub's id of #946. */
export const SUBJECT = { id: "1001", kind: "pull_request" } as const;
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

export function checkSuiteCompleted(conclusion = "success") {
  return signedRequest(
    {
      action: "completed",
      check_suite: {
        conclusion,
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

export function pullRequestAction(
  action: string,
  merged = false,
  /** The reviewer of a `review_requested` event. */
  requestedReviewer?: string,
) {
  return signedRequest(
    {
      action,
      ...(requestedReviewer
        ? { requested_reviewer: { login: requestedReviewer } }
        : undefined),
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
    body?: string;
    commit_id?: string;
    /** The ids of the review's inline comments. */
    comments?: number[];
    id?: number;
    state: string;
    submitted_at?: string;
    user: { login: string };
  }>;
  /**
   * Junior's feedback reactions, by `review:<id>` for a review body and
   * `comment:<id>` for an inline comment.
   */
  feedback?: Record<string, string>;
  /** Feedback keys that GitHub's GraphQL read does not show yet. */
  laggingFeedback?: string[];
  /** GitHub rejects review requests, such as during an outage. */
  rejectReviewRequests?: boolean;
  /** The checks of the head commit. */
  checks?: Array<{ conclusion: string | null; name: string; status: string }>;
  /** The checks that a ruleset of the base branch requires. */
  requiredChecks?: string[];
  state: "closed" | "open";
  /** The pull request title. */
  title?: string;
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

// The bot's reactions in GraphQL, as reaction groups.
function graphqlReactionGroups(github: GitHubState, key: string) {
  return github.laggingFeedback?.includes(key)
    ? []
    : botReactionGroups(github, key);
}

function botReactionGroups(github: GitHubState, key: string) {
  const content = github.feedback?.[key];
  return content
    ? [
        {
          content: { "+1": "THUMBS_UP", "-1": "THUMBS_DOWN", eyes: "EYES" }[
            content
          ],
          reactors: { nodes: [{ databaseId: BOT_USER_ID }] },
        },
      ]
    : [];
}

// What the feedback tool and the check suite webhook read to decide
// whether to ask a reviewer again.
function reviewAgainPull(github: GitHubState, reviewer: string) {
  const review = github.reviews
    .filter(
      (item) =>
        item.user.login.toLowerCase() === reviewer.toLowerCase() &&
        item.state !== "COMMENTED",
    )
    .at(-1);
  return {
    baseRef: { refUpdateRule: null },
    baseRefName: "main",
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: (github.checks ?? []).map((check) => ({
                  __typename: "CheckRun",
                  ...check,
                })),
                pageInfo: { hasNextPage: false },
              },
            },
          },
        },
      ],
    },
    reviewRequests: {
      nodes: (github.requestedReviewers ?? []).map((login) => ({
        requestedReviewer: { __typename: "User", login },
      })),
    },
    reviews: {
      nodes: review
        ? [
            {
              body: review.body ?? "Please change this.",
              databaseId: review.id ?? null,
              comments: {
                nodes: (review.comments ?? []).map((id) => ({
                  databaseId: id,
                  reactionGroups: graphqlReactionGroups(
                    github,
                    `comment:${id}`,
                  ),
                })),
                totalCount: review.comments?.length ?? 0,
              },
              reactionGroups: graphqlReactionGroups(
                github,
                `review:${review.id}`,
              ),
              state: review.state,
            },
          ]
        : [],
    },
  };
}

export function mockGitHub(github: GitHubState, requests: string[]) {
  const reviewOfComment = (id: number) =>
    github.reviews.find((review) => review.comments?.includes(id));
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
          title: github.title ?? "Add the Inbox notice",
          user: { id: BOT_USER_ID },
        });
      },
    ),
    // The repository has no changelog categories, so defaults apply.
    http.get(
      "https://api.github.com/repos/getsentry/junior/contents/.github/release.yml",
      () => HttpResponse.json({ message: "Not Found" }, { status: 404 }),
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
    // The feedback tool reads one inline comment, and sets its reaction.
    http.get(
      "https://api.github.com/repos/getsentry/junior/pulls/comments/:id",
      ({ params }) =>
        HttpResponse.json({
          pull_request_url:
            "https://api.github.com/repos/getsentry/junior/pulls/946",
          user: reviewOfComment(Number(params["id"]))?.user ?? null,
        }),
    ),
    http.get(
      "https://api.github.com/repos/getsentry/junior/pulls/comments/:id/reactions",
      ({ params }) => {
        const content = github.feedback?.[`comment:${String(params["id"])}`];
        return HttpResponse.json(
          content ? [{ content, id: 1, user: { id: BOT_USER_ID } }] : [],
        );
      },
    ),
    http.delete(
      "https://api.github.com/repos/getsentry/junior/pulls/comments/:id/reactions/:reaction",
      ({ params }) => {
        delete github.feedback?.[`comment:${String(params["id"])}`];
        return new HttpResponse(null, { status: 204 });
      },
    ),
    http.post(
      "https://api.github.com/repos/getsentry/junior/pulls/comments/:id/reactions",
      async ({ params, request }) => {
        const { content } = (await request.json()) as { content: string };
        (github.feedback ??= {})[`comment:${String(params["id"])}`] = content;
        return HttpResponse.json({ content, id: 1 }, { status: 201 });
      },
    ),
    http.get(
      "https://api.github.com/repos/getsentry/junior/rules/branches/main",
      () => {
        requests.push("rules");
        return HttpResponse.json(
          github.requiredChecks
            ? [
                {
                  parameters: {
                    required_status_checks: github.requiredChecks.map(
                      (context) => ({ context }),
                    ),
                  },
                  type: "required_status_checks",
                },
              ]
            : [],
        );
      },
    ),
    http.post("https://api.github.com/graphql", async ({ request }) => {
      const { operationName, variables } = (await request.json()) as {
        operationName: string;
        variables: {
          before?: string;
          content?: string;
          reviewer?: string;
          subjectId?: string;
        };
      };
      const reviewKey = `review:${variables.subjectId?.replace("PRR_", "")}`;
      if (operationName === "PullRequestReviewAgain") {
        requests.push("review again");
        return HttpResponse.json({
          data: {
            repository: {
              pullRequest: reviewAgainPull(github, variables.reviewer ?? ""),
            },
          },
        });
      }
      if (operationName === "ReviewReactions") {
        return HttpResponse.json({
          data: {
            node: { reactionGroups: botReactionGroups(github, reviewKey) },
          },
        });
      }
      if (operationName === "AddReviewReaction") {
        (github.feedback ??= {})[reviewKey] =
          { THUMBS_DOWN: "-1", THUMBS_UP: "+1" }[variables.content ?? ""] ??
          "eyes";
        return HttpResponse.json({ data: { addReaction: {} } });
      }
      if (operationName === "RemoveReviewReaction") {
        delete github.feedback?.[reviewKey];
        return HttpResponse.json({ data: { removeReaction: {} } });
      }
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
                title: github.title ?? "Add the Inbox notice",
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
        if (github.rejectReviewRequests) {
          requests.push(`rejected ${reviewers.join(",")}`);
          return HttpResponse.json({}, { status: 503 });
        }
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

/**
 * Mark one review body or inline review comment with the feedback tool, as
 * Junior does. `state` is the plugin state that the webhook route reads.
 */
export async function markFeedback(
  state: PluginState,
  target: { id: number; kind: "review" | "review_body" },
  status: "addressed" | "declined" = "addressed",
): Promise<void> {
  const tool = bindPluginTool(
    githubPlugin().hooks!.tools!()["updatePullRequestFeedback"],
    {
      egress: {
        fetch: async ({ request }: { request: Request }) =>
          await fetch(request),
      },
      log: { error() {}, info() {}, warn() {} },
      state,
      users: { replaceSlackMentions: async (value: unknown) => value },
    } as never,
  );
  await tool.execute(
    {
      comment_id: target.id,
      comment_kind: target.kind,
      pull_request: 946,
      repo: "getsentry/junior",
      status,
    },
    { toolCallId: `${status}-${target.kind}-${target.id}` },
  );
}

export type InboxItemCall =
  | { conversationId: string; kind: "upsert"; notice: unknown }
  | { conversationId: string; input: unknown; kind: "close" };

export function route(
  fixture: GitHubFixture,
  calls: InboxItemCall[],
  /** Each logged error, as `message: cause name` when it has a cause. */
  errors: string[] = [],
  failures = { close: 0 },
  /** Keys of the other closed items, such as from before one item per pull request. */
  otherCloses: string[] = [],
  /** The plugin state, shared with the feedback tool. */
  state: PluginState = memoryState(),
  /** The Identity of each reviewer who linked their GitHub login. */
  linkedReviewers: Readonly<Record<string, string>> = {},
): PluginRoute {
  const isReady = (subject: { id: string; kind: string }) =>
    subject.kind === SUBJECT.kind && subject.id === SUBJECT.id;
  // Like core: a person joins only when asked, an upsert that changes
  // nothing and asks nobody does nothing, and a close needs an open item.
  let open: PluginReviewNotice | undefined;
  const inboxItems: PluginConversationInboxItems = {
    forConversation(conversationId) {
      return {
        async upsert(notice) {
          if (!isReady(notice.subject)) return;
          const on = new Set(open?.assigneeIdentityIds);
          const assigneeIdentityIds = notice.assigneeIdentityIds.filter(
            (id) => notice.askedIdentityIds.includes(id) || on.has(id),
          );
          if (assigneeIdentityIds.length === 0) return;
          const shown = { ...notice, assigneeIdentityIds };
          if (
            notice.askedIdentityIds.length === 0 &&
            JSON.stringify({ ...open, askedIdentityIds: [] }) ===
              JSON.stringify({ ...shown, askedIdentityIds: [] })
          ) {
            return;
          }
          open = shown;
          calls.push({ conversationId, kind: "upsert", notice });
          return;
        },
        async close(input) {
          if (!isReady(input.subject)) {
            otherCloses.push(`${input.subject.kind}:${input.subject.id}`);
            return false;
          }
          if (failures.close > 0) {
            failures.close -= 1;
            throw new Error("Inbox is down");
          }
          if (!open) return false;
          open = undefined;
          calls.push({ conversationId, input, kind: "close" });
          return true;
        },
      };
    },
  };
  // These webhooks use no Conversation dispatch or cache.
  const unused = () => {
    throw new Error("The next-action webhooks do not use this");
  };
  const annotations: PluginConversationAnnotations = {
    forConversation() {
      return {
        async upsert() {},
        async remove() {},
        async list() {
          return [];
        },
      };
    },
  };
  const [webhook] = githubPlugin().hooks!.routes!({
    agent: { dispatchForIdentity: unused },
    annotations,
    codeChanges: {
      async associateConversations() {},
      async recordActivity() {},
      async record() {},
    },
    conversationChanges: conversationChangesThrough({
      annotations,
      inboxItems,
    }),
    db: fixture.db(),
    log: {
      error(message, _metadata, cause) {
        errors.push(
          cause instanceof Error ? `${message}: ${cause.name}` : message,
        );
      },
      info() {},
      warn() {},
    },
    plugin: { name: "github" },
    events: { hasMatch: async () => false, async publish() {} },
    cache: { getOrLoad: unused },
    inboxItems,
    state,
    tasks: { start: unused },
    // The requester linked the GitHub account `Requester`, and each
    // reviewer in `linkedReviewers` linked theirs.
    users: {
      findLinkedIdentityIds: async (logins) =>
        new Map(
          logins.flatMap((login) => {
            const identityId = linkedReviewers[login.toLowerCase()];
            return identityId
              ? [[login.toLowerCase(), identityId] as const]
              : [];
          }),
        ),
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
