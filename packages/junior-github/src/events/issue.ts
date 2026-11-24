import {
  eventMatchFieldsSchema,
  mergeEventMatchFields,
  type Actor,
  type PluginEventToolContext,
  type PluginLogger,
  type Source,
  type SubscribableResource,
  type WatchResult,
} from "@sentry/junior-plugin-api";
import {
  gitHubCommentMatchFields,
  gitHubSenderMatchFields,
} from "./comment.js";
import { startedByPerson } from "../tool-support/attribution.js";
import { gitHubRepoDataSchema, gitHubRepoMatchFields } from "./scope.js";

export const GITHUB_ISSUE_EVENTS = [
  "issue.comment.created",
  "issue.opened",
  "issue.closed",
  "issue.reopened",
  "issue.updated",
];
export const GITHUB_ISSUE_SUGGESTED_EVENTS = [
  "issue.comment.created",
  "issue.closed",
  "issue.reopened",
  "issue.updated",
];

/**
 * The `issues` webhook actions that `issue.updated` publishes. The webhook
 * schema and the `change` match field both use this list.
 */
export const GITHUB_ISSUE_UPDATE_CHANGES = [
  "edited",
  "labeled",
  "unlabeled",
  "assigned",
  "unassigned",
  "milestoned",
  "demilestoned",
] as const;

/**
 * Exact values GitHub sets on issue event data. Every issue event sets the
 * repository and issue number. Comments and updates set who acted. Only
 * updates set `change` and `label`, so an automation can run on one label
 * that one person adds without the model deciding from untrusted text.
 */
export const GITHUB_ISSUE_MATCH_FIELDS = mergeEventMatchFields(
  gitHubCommentMatchFields(["issue.comment.created"]),
  gitHubSenderMatchFields(["issue.updated"]),
  eventMatchFieldsSchema.parse({
    ...gitHubRepoMatchFields(GITHUB_ISSUE_EVENTS),
    issue: {
      kind: "number",
      description: "issue number, such as 12",
      events: GITHUB_ISSUE_EVENTS,
    },
    change: {
      kind: "string",
      enum: [...GITHUB_ISSUE_UPDATE_CHANGES],
      description: "what the issue update changed, such as labeled",
      events: ["issue.updated"],
    },
    label: {
      kind: "string",
      case: "lower",
      description:
        "lowercase name of the label that was added or removed, set only when change is labeled or unlabeled",
      events: ["issue.updated"],
    },
  }),
);

/** The identifier shape that `gitHubIssueResource` builds. */
export const GITHUB_ISSUE_IDENTIFIER = {
  format: "owner/repo#number",
  pattern: String.raw`^[^\s/:#]+\/[^\s/:#]+#\d+$`,
};

/** Build the stable issue identity shared by tools and webhooks. */
export function gitHubIssueResource(input: {
  number: number;
  repo: string;
}): Pick<SubscribableResource, "label" | "namespace" | "identifier"> {
  return {
    label: `GitHub issue ${input.repo}#${input.number}`,
    namespace: "github",
    identifier: `${input.repo.toLowerCase()}#${input.number}`,
  };
}

/**
 * Describe an issue as a resource that a conversation can watch.
 * Return undefined when the host cannot create Watches.
 */
export function gitHubIssueSubscribable(input: {
  /** `ctx.events.canSubscribe` from the tool context. */
  canSubscribe: boolean;
  number: number;
  repo: string;
  /** Events already covered by a forced subscription; omit them from suggestions. */
  omitSuggestedEvents?: readonly string[];
}): SubscribableResource | undefined {
  if (!input.canSubscribe) return undefined;
  const omitted = new Set(input.omitSuggestedEvents ?? []);
  const suggestedEvents = GITHUB_ISSUE_SUGGESTED_EVENTS.filter(
    (eventType) => !omitted.has(eventType),
  );
  return {
    ...gitHubIssueResource(input),
    match: {
      repo: gitHubRepoDataSchema.parse(input.repo),
      issue: input.number,
    },
    ...(suggestedEvents.length > 0
      ? { suggested_events: suggestedEvents }
      : undefined),
    supported_events: GITHUB_ISSUE_EVENTS,
    type: "issue",
  };
}

/**
 * Junior files issues for people, but the issue is not its work to fix. So
 * the Watch wakes only on comments, where a person may ask something that
 * the requester must answer. GitHub already tells people about closes,
 * reopens, and label changes. Junior's own close or reopen would also wake
 * the Watch, because those webhooks do not skip the bot.
 */
const GITHUB_ISSUE_WATCH = {
  events: ["issue.comment.created"],
  intent:
    "Follow GitHub issues that you create or update. When a comment asks a question or for a decision that only the person who asked for the issue can give, ask that person: name what they must answer or decide, and link the comment. Do not reply on GitHub, change the issue, or start work because of a comment, unless a person in the thread asks you to. Otherwise stay silent: GitHub already shows comments, so do not post status updates.",
};

/**
 * Watch an issue that a tool created or updated, for the current
 * Conversation. The Watch id depends on the Conversation, resource, and
 * events, so a repeat call replaces the same Watch. A failed subscribe still
 * returns the issue: the write already happened.
 */
export async function watchGitHubIssue(
  ctx: {
    actor?: Actor | undefined;
    events: PluginEventToolContext;
    log: PluginLogger;
    source?: Source | undefined;
  },
  input: { number: number; repo: string },
): Promise<{
  subscribable?: SubscribableResource;
  subscription?: WatchResult;
}> {
  const subscribable = gitHubIssueSubscribable({
    canSubscribe: ctx.events.canSubscribe,
    ...input,
  });
  if (!subscribable) return {};
  // A run that acts for no person, such as one that triages many issues,
  // would get a Watch for each issue.
  if (!startedByPerson(ctx)) {
    return { subscribable };
  }
  try {
    const subscription = await ctx.events.subscribe({
      ...GITHUB_ISSUE_WATCH,
      resource: subscribable,
    });
    const remaining = gitHubIssueSubscribable({
      canSubscribe: ctx.events.canSubscribe,
      ...input,
      omitSuggestedEvents: subscription.events,
    });
    return {
      ...(remaining ? { subscribable: remaining } : undefined),
      subscription,
    };
  } catch (error) {
    ctx.log.warn("github.issue.subscribe.failed", {
      error: error instanceof Error ? error.message : String(error),
      number: input.number,
      repo: input.repo,
    });
    return { subscribable };
  }
}
