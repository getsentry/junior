import {
  eventMatchFieldsSchema,
  type SubscribableResource,
} from "@sentry/junior-plugin-api";
import { gitHubCommentMatchFields } from "./comment.js";
import {
  gitHubCommitMatchFields,
  gitHubRepoDataSchema,
  gitHubRepoMatchFields,
} from "./scope.js";

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

/**
 * A stack merges only with a linear history, so a stacked pull request is
 * rebased, never merged with its base. GitHub rebases the next pull request
 * after a merge, but it stops at a conflict and sends no event for it.
 */
const STACK_CHECK =
  "Check if the pull request is in a stack: `gh api 'repos/OWNER/REPO/stacks?pull_request=NUMBER'`.";
const STACK_CONFLICT_STEPS =
  "run `gh stack rebase`, resolve each conflict so that both changes stay intact, stage the files, and run `gh stack rebase --continue`. Run the checks again, run `gh stack push`, and confirm that each open pull request in the stack can merge. Report the files that had conflicts.";

/**
 * Every comment on a pull request gets the same feedback status: a
 * conversation comment, an inline review comment, and a review body. A review
 * sets comment_id only when it has a body.
 */
const PULL_REQUEST_FEEDBACK =
  'When Verified details include comment_id, call github_updatePullRequestFeedback after acting on actionable feedback, with the exact repo, pull_request, comment_id, and comment_kind from Verified details, and status "addressed" or "declined".';

const GITHUB_PULL_REQUEST_EVENT_GUIDANCE: Partial<
  Record<GitHubPullRequestEvent, string>
> = {
  "pull_request.checks.failed":
    "Fix only failures that the pull request causes. Do not skip, disable, or weaken a check to make it pass.",
  // An approval with a body also arrives as review.commented in the same
  // Turn, so this guidance must not tell the agent to hold off on that body.
  "pull_request.review.approved": `When the approval includes actionable feedback, address it like any other review feedback. ${PULL_REQUEST_FEEDBACK}`,
  "pull_request.review.changes_requested": PULL_REQUEST_FEEDBACK,
  "pull_request.review.commented": PULL_REQUEST_FEEDBACK,
  "pull_request.comment.created": PULL_REQUEST_FEEDBACK,
  "pull_request.review_comment.created": `${PULL_REQUEST_FEEDBACK} Then resolve the thread with github_resolvePullRequestReviewThread.`,
  "pull_request.merge_conflict": `${STACK_CHECK} If it is, run \`gh stack checkout NUMBER\`, then ${STACK_CONFLICT_STEPS} If it is not, fetch base_branch from Verified details and merge it into the pull request branch. Do not rebase. Resolve each conflict so that both the pull request change and the base branch change stay intact. Run the checks again, push, and confirm that the pull request can merge. Report the files that had conflicts.`,
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
  /**
   * Temporary subscription created after Junior creates a pull request.
   * Defaults to the maintenance Watch below. `false` turns it off.
   */
  subscribeAfterCreate?: GitHubPullRequestSubscriptionConfig | false;
}

/** Temporary subscription created after Junior creates a pull request. */
export interface GitHubPullRequestSubscriptionConfig {
  events: GitHubPullRequestEvent[];
  intent: string;
}

/**
 * Junior maintains the pull requests it creates. The pull request is its own
 * work, so it answers and fixes review feedback without asking first.
 */
const DEFAULT_PULL_REQUEST_SUBSCRIPTION: GitHubPullRequestSubscriptionConfig = {
  events: [
    "pull_request.checks.failed",
    "pull_request.closed_unmerged",
    "pull_request.comment.created",
    "pull_request.review.changes_requested",
    "pull_request.review.commented",
    "pull_request.review_comment.created",
  ],
  intent:
    "Maintain pull requests Junior creates. For actionable review feedback or failed checks, inspect the evidence, make scoped fixes, verify them, and push, without asking first. Reply on GitHub to review comments and questions, in the thread where they were asked. Report completed work or blockers in the originating thread. Report when the pull request closes unmerged. When a reviewer submits a review, notify the person who asked for the pull request by mentioning them, with the reviewer, the review outcome, and the pull request link. Stay silent on other events that are not feedback.",
};

/** Resolve the Watch to create after Junior creates a pull request, if any. */
export function gitHubPullRequestSubscription(
  config: GitHubPullRequestSubscriptionConfig | false | undefined,
): GitHubPullRequestSubscriptionConfig | undefined {
  if (config === false) return undefined;
  return config ?? DEFAULT_PULL_REQUEST_SUBSCRIPTION;
}

/**
 * A reply about an approval tends to guess why GitHub blocks the merge, or
 * miss that a person already turned on auto-merge. The branch rules and the
 * pull request's merge state settle both, and read access is enough.
 */
const MERGE_STATE_CHECK =
  "Do not guess whether it can merge. Before you say anything about that, call github_getPullRequest and read its `checks`. If `checks.required` is `not_reported`, the required checks may not have started on the latest commit yet. It does not mean that none are required. If `checks.auto_merge` is true and only required checks remain, say only that it merges when they pass. If `checks.merge_state` shows that GitHub blocks it for another reason, run `gh api repos/OWNER/REPO/rules/branches/BASE` and name the rule that blocks it. Do not say that you did not merge it.";

/**
 * Watch guidance for outcomes that the people involved need to hear about.
 * The Watch made after Junior creates a pull request always receives these
 * events. The webhook adds the people involved in the pull request to them.
 * A merge does not ask the agent to check for a stack: GitHub rebases the
 * next pull request in a stack itself, and most merges are not stacked.
 */
const GITHUB_PULL_REQUEST_OUTCOME_GUIDANCE = {
  "pull_request.review.approved": `Mention each person in People involved, or the person who asked for the pull request if that line is missing. Say who approved it and link it. Do not merge it unless asked. ${MERGE_STATE_CHECK}`,
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
 * Pull request events that a GitHub webhook payload describes. GitHub sends
 * no webhook when a pull request gets a conflict, so the webhook reads the
 * pull request for `pull_request.merge_conflict` instead.
 */
const GITHUB_PULL_REQUEST_PAYLOAD_EVENTS = GITHUB_PULL_REQUEST_EVENTS.filter(
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
 * `webhooks/pull-request-match-data.ts` for every payload pull request event.
 * The pull request comment webhook has no head branch. A check suite result
 * that GitHub links to no pull request has no `pullRequest`. The webhook
 * checks for a Watch or event automation before it reads a pull request for
 * a conflict, so `pull_request.merge_conflict` matches only `repo` and
 * `pullRequest`.
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
    events: [...GITHUB_PULL_REQUEST_PAYLOAD_EVENTS],
  },
  headBranch: {
    kind: "string",
    description: "head branch name from the webhook",
    events: GITHUB_PULL_REQUEST_PAYLOAD_EVENTS.filter(
      (eventType) => eventType !== "pull_request.comment.created",
    ),
  },
  isDraft: {
    kind: "boolean",
    description: "true when the pull request is a draft",
    events: [...GITHUB_PULL_REQUEST_PAYLOAD_EVENTS],
  },
  openerEmail: {
    kind: "string",
    description:
      "opener email when GitHub sends it; missing on pull requests that this GitHub App opened",
    events: [...GITHUB_PULL_REQUEST_PAYLOAD_EVENTS],
  },
  openerUsername: {
    kind: "string",
    description:
      "login of who opened the pull request; on pull requests that this GitHub App opened, the person who asked for it, missing until that person is saved",
    events: [...GITHUB_PULL_REQUEST_PAYLOAD_EVENTS],
  },
  openerRole: {
    kind: "string",
    description:
      "opener's repository role: admin, maintain, write, triage, read, none (no access, such as most bots), or a custom role name",
    events: [...GITHUB_PULL_REQUEST_PAYLOAD_EVENTS],
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
    match: {
      repo: gitHubRepoDataSchema.parse(input.repo),
      pull_request: input.number,
    },
    ...(suggestedEvents.length > 0
      ? { suggested_events: [...suggestedEvents] }
      : undefined),
    supported_events: [...GITHUB_PULL_REQUEST_EVENTS],
    type: "pull_request",
  };
}
