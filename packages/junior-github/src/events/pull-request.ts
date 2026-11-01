import {
  eventMatchFieldsSchema,
  type SubscribableResource,
} from "@sentry/junior-plugin-api";
import { gitHubCommentMatchFields } from "./comment.js";
import { gitHubCommitMatchFields, gitHubRepoMatchFields } from "./scope.js";

export const GITHUB_PULL_REQUEST_EVENTS = [
  "pull_request.checks.failed",
  "pull_request.checks.recovered",
  "pull_request.comment.created",
  "pull_request.opened",
  "pull_request.ready_for_review",
  "pull_request.review.approved",
  "pull_request.review.changes_requested",
  "pull_request.review.commented",
  "pull_request.review_comment.created",
  "pull_request.merged",
  "pull_request.closed_unmerged",
  "pull_request.merge_conflict",
] as const;
export type GitHubPullRequestEvent =
  (typeof GITHUB_PULL_REQUEST_EVENTS)[number];

const GITHUB_PULL_REQUEST_EVENT_GUIDANCE: Partial<
  Record<GitHubPullRequestEvent, string>
> = {
  "pull_request.comment.created":
    'After acting on actionable feedback, call github_updatePullRequestFeedback with the exact repo, commentId, and commentKind from Verified details, and status "addressed" or "declined".',
  "pull_request.review_comment.created":
    'After acting on actionable feedback, call github_updatePullRequestFeedback with the exact repo, commentId, and commentKind from Verified details, and status "addressed" or "declined". Then resolve the thread with github_resolvePullRequestReviewThread.',
  "pull_request.merge_conflict":
    "Fetch baseBranch from Verified details and merge it into the pull request branch. Do not rebase. Resolve each conflict so that both the pull request change and the base branch change stay intact. Run the checks again, push, and confirm that the pull request can merge. Report the files that had conflicts.",
};

/** Combine provider defaults with app guidance for pull request events. */
export function gitHubPullRequestEventGuidance(
  guidance?: Partial<Record<GitHubPullRequestEvent, string>>,
): Partial<Record<GitHubPullRequestEvent, string>> {
  const merged = { ...GITHUB_PULL_REQUEST_EVENT_GUIDANCE };
  for (const eventType of GITHUB_PULL_REQUEST_EVENTS) {
    const extra = guidance?.[eventType]?.trim();
    if (!extra) continue;
    const base = merged[eventType];
    merged[eventType] = base ? `${base} ${extra}` : extra;
  }
  return merged;
}

/** App-configured pull request event behavior. */
export interface GitHubPullRequestEventOptions {
  /** App guidance applied within the matching subscription or event automation instruction. */
  guidance?: Partial<Record<GitHubPullRequestEvent, string>>;
  /** Temporary subscription created after Junior creates a pull request. */
  subscribeAfterCreate?: GitHubPullRequestSubscriptionConfig;
}

/** Temporary subscription created after Junior creates a pull request. */
export interface GitHubPullRequestSubscriptionConfig {
  events: GitHubPullRequestEvent[];
  intent: string;
}

/**
 * Watch guidance for outcomes that the people involved need to hear about.
 * The Watch made after Junior creates a pull request always receives these
 * events. The webhook adds the people involved in the pull request to them.
 */
const GITHUB_PULL_REQUEST_OUTCOME_GUIDANCE = {
  "pull_request.review.approved":
    "Mention each person in People involved, or the person who asked for the pull request if that line is missing. Say who approved it and link it. Do not merge it unless asked.",
  "pull_request.merged":
    "Mention each person in People involved, or the person who asked for the pull request if that line is missing. Say that it merged and link it.",
} as const satisfies Partial<Record<GitHubPullRequestEvent, string>>;

/** Build the Watch created after Junior creates a pull request. */
export function gitHubPullRequestCreateWatch(
  config: GitHubPullRequestSubscriptionConfig,
): {
  events: GitHubPullRequestEvent[];
  guidance: Partial<Record<GitHubPullRequestEvent, string>>;
  intent: string;
} {
  const outcomeEvents = Object.keys(
    GITHUB_PULL_REQUEST_OUTCOME_GUIDANCE,
  ) as GitHubPullRequestEvent[];
  return {
    events: [
      ...new Set([
        ...config.events,
        // GitHub sends no webhook for a new conflict, so keep the pull
        // request ready to merge even when the app config omits this event.
        "pull_request.merge_conflict" as const,
        ...outcomeEvents,
      ]),
    ],
    guidance: GITHUB_PULL_REQUEST_OUTCOME_GUIDANCE,
    intent: config.intent,
  };
}

export const GITHUB_PULL_REQUEST_SUGGESTED_EVENTS = [
  "pull_request.checks.failed",
  "pull_request.comment.created",
  "pull_request.ready_for_review",
  "pull_request.review.changes_requested",
  "pull_request.review.commented",
  "pull_request.review_comment.created",
  "pull_request.merged",
  "pull_request.closed_unmerged",
  "pull_request.merge_conflict",
] as const;

/**
 * Pull request events from GitHub webhooks. The heartbeat finds
 * `pull_request.merge_conflict` by polling, because GitHub sends no webhook
 * when a pull request gets a conflict.
 */
const GITHUB_PULL_REQUEST_WEBHOOK_EVENTS = GITHUB_PULL_REQUEST_EVENTS.filter(
  (eventType) => eventType !== "pull_request.merge_conflict",
);

/** Pull request events that a comment or review starts. */
const GITHUB_PULL_REQUEST_COMMENT_EVENTS = [
  "pull_request.comment.created",
  "pull_request.review.approved",
  "pull_request.review.changes_requested",
  "pull_request.review.commented",
  "pull_request.review_comment.created",
] as const satisfies readonly GitHubPullRequestEvent[];

/** Pull request events that a check suite result starts. */
const GITHUB_PULL_REQUEST_CHECK_EVENTS = [
  "pull_request.checks.failed",
  "pull_request.checks.recovered",
] as const satisfies readonly GitHubPullRequestEvent[];

/**
 * Exact values GitHub may set on pull request event data. Missing keys do not
 * match. The opener and author values load in
 * `webhooks/pull-request-match-data.ts` for every webhook pull request event.
 * The pull request comment webhook has no head branch. A check suite result
 * that GitHub links to no pull request has no `pullRequest`. The heartbeat
 * checks for a Watch or event automation before it reads a pull request, so
 * `pull_request.merge_conflict` matches only `repo` and `pullRequest`.
 */
export const GITHUB_PULL_REQUEST_MATCH_FIELDS = eventMatchFieldsSchema.parse({
  ...gitHubCommentMatchFields(GITHUB_PULL_REQUEST_COMMENT_EVENTS),
  ...gitHubRepoMatchFields(GITHUB_PULL_REQUEST_EVENTS),
  ...gitHubCommitMatchFields(GITHUB_PULL_REQUEST_CHECK_EVENTS),
  pullRequest: {
    kind: "number",
    description: "pull request number, such as 946",
    events: [...GITHUB_PULL_REQUEST_EVENTS],
  },
  authors: {
    kind: "string",
    list: true,
    description:
      "GitHub logins of the commit authors and Co-authored-by people, including bots such as this GitHub App",
    events: [...GITHUB_PULL_REQUEST_WEBHOOK_EVENTS],
  },
  headBranch: {
    kind: "string",
    description: "head branch name from the webhook",
    events: GITHUB_PULL_REQUEST_WEBHOOK_EVENTS.filter(
      (eventType) => eventType !== "pull_request.comment.created",
    ),
  },
  isDraft: {
    kind: "boolean",
    description: "true when the pull request is a draft",
    events: [...GITHUB_PULL_REQUEST_WEBHOOK_EVENTS],
  },
  openerEmail: {
    kind: "string",
    description:
      "opener email when GitHub sends it; missing on pull requests that this GitHub App opened",
    events: [...GITHUB_PULL_REQUEST_WEBHOOK_EVENTS],
  },
  openerUsername: {
    kind: "string",
    description:
      "login of who opened the pull request; on pull requests that this GitHub App opened, the person who asked for it, missing until that person is saved",
    events: [...GITHUB_PULL_REQUEST_WEBHOOK_EVENTS],
  },
  openerRole: {
    kind: "string",
    description:
      "opener's repository role: admin, maintain, write, triage, read, none (no access, such as most bots), or a custom role name",
    events: [...GITHUB_PULL_REQUEST_WEBHOOK_EVENTS],
  },
});

/** The identifier shape that `gitHubPullRequestResource` builds. */
export const GITHUB_PULL_REQUEST_IDENTIFIER = {
  format: "owner/repo#number",
  pattern: String.raw`^[^\s/:#]+\/[^\s/:#]+#\d+$`,
};

/** Build the stable pull request identity shared by tools and webhooks. */
export function gitHubPullRequestResource(input: {
  number: number;
  repo: string;
}): Pick<SubscribableResource, "label" | "namespace" | "identifier"> {
  return {
    label: `GitHub PR ${input.repo}#${input.number}`,
    namespace: "github",
    identifier: `${input.repo.toLowerCase()}#${input.number}`,
  };
}

/**
 * Describe a pull request as a resource that a conversation can watch.
 * Return undefined when the host cannot create Watches.
 */
export function gitHubPullRequestSubscribable(input: {
  /** `ctx.events.canSubscribe` from the tool context. */
  canSubscribe: boolean;
  number: number;
  repo: string;
  /** Events already covered by a forced subscription; omit them from suggestions. */
  omitSuggestedEvents?: readonly string[];
}): SubscribableResource | undefined {
  if (!input.canSubscribe) return undefined;
  const omitted = new Set(input.omitSuggestedEvents ?? []);
  const suggestedEvents = GITHUB_PULL_REQUEST_SUGGESTED_EVENTS.filter(
    (eventType) => !omitted.has(eventType),
  );
  return {
    ...gitHubPullRequestResource(input),
    ...(suggestedEvents.length > 0
      ? { suggestedEvents: [...suggestedEvents] }
      : undefined),
    supportedEvents: [...GITHUB_PULL_REQUEST_EVENTS],
    type: "pull_request",
  };
}
