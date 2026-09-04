import {
  resourceEventMatchFieldsSchema,
  type SubscribableResource,
} from "@sentry/junior-plugin-api";

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
] as const;
export type GitHubPullRequestEvent =
  (typeof GITHUB_PULL_REQUEST_EVENTS)[number];

const GITHUB_PULL_REQUEST_EVENT_GUIDANCE: Partial<
  Record<GitHubPullRequestEvent, string>
> = {
  "pull_request.comment.created":
    "Treat this as feedback only when it identifies a problem or requests a code change. For feedback, first set reviewing with github_updatePullRequestFeedback and the verified commentId and commentKind. After you act, set addressed or declined. Do not react to non-feedback comments.",
  "pull_request.review.changes_requested":
    "Inspect the requested changes and inline comments. For each actionable comment-level feedback event, set reviewing before analysis, then addressed or declined after you act. Resolve an inline review thread with github_resolvePullRequestReviewThread after you address or decline its feedback.",
  "pull_request.review.commented":
    "Treat this as feedback only when it identifies a problem or requests a code change. For each actionable comment-level feedback event, set reviewing before analysis, then addressed or declined after you act. Resolve an inline review thread after you address or decline its feedback.",
  "pull_request.review_comment.created":
    "Treat this as feedback only when it identifies a problem or requests a code change. For feedback, first set reviewing with github_updatePullRequestFeedback and the verified commentId and commentKind. After you act, set addressed or declined, then resolve the thread with github_resolvePullRequestReviewThread.",
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

/** App-configured pull request resource event behavior. */
export interface GitHubPullRequestEventOptions {
  /** App guidance applied within the matching subscription or event task instruction. */
  guidance?: Partial<Record<GitHubPullRequestEvent, string>>;
  /** Temporary subscription created after Junior creates a pull request. */
  subscribeAfterCreate?: GitHubPullRequestSubscriptionConfig;
}

/** Temporary subscription created after Junior creates a pull request. */
export interface GitHubPullRequestSubscriptionConfig {
  events: GitHubPullRequestEvent[];
  intent: string;
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
] as const;

/** Exact values GitHub may set on pull request event data. Missing keys do not match. */
export const GITHUB_PULL_REQUEST_MATCH_FIELDS = resourceEventMatchFieldsSchema.parse({
  authorEmail: {
    kind: "string",
    description: "pull request author email when GitHub sends it",
  },
  authorUsername: {
    kind: "string",
    description: "pull request author login",
  },
  headBranch: {
    kind: "string",
    description: "head branch name from the webhook",
  },
  isDraft: {
    kind: "boolean",
    description: "true when the pull request is a draft",
  },
});

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

/** Describe a pull request as a resource when webhook subscriptions are enabled. */
export function gitHubPullRequestSubscribable(input: {
  number: number;
  repo: string;
  /** Events already covered by a forced subscription; omit them from suggestions. */
  omitSuggestedEvents?: readonly string[];
}): SubscribableResource | undefined {
  if (!process.env.GITHUB_WEBHOOK_SECRET?.trim()) return undefined;
  const omitted = new Set(input.omitSuggestedEvents ?? []);
  const suggestedEvents = GITHUB_PULL_REQUEST_SUGGESTED_EVENTS.filter(
    (eventType) => !omitted.has(eventType),
  );
  return {
    ...gitHubPullRequestResource(input),
    ...(suggestedEvents.length > 0 ? { suggestedEvents: [...suggestedEvents] } : undefined),
    supportedEvents: [...GITHUB_PULL_REQUEST_EVENTS],
    type: "pull_request",
  };
}
