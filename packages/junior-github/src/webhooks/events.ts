import type { EventInput } from "@sentry/junior-plugin-api";
import { z } from "zod";
import { gitHubDeploymentSourceResource } from "../events/deployment.js";
import { gitHubIssueResource } from "../events/issue.js";
import { gitHubPullRequestResource } from "../events/pull-request.js";
import { gitHubReleaseSourceResource } from "../events/release.js";
import { gitHubRepositoryResource } from "../events/repository.js";
import {
  normalizeCheckSuiteEvents,
  type GitHubCheckSuiteFacts,
} from "./check-suite.js";
import { gitHubEventKey, pullRequestTargets } from "./event-targets.js";
import { isBotLogin, mentionsBotLogin } from "./ownership.js";

export type {
  GitHubCheckSuiteFacts,
  GitHubCheckSuitePullRequestFacts,
  GitHubFailingCheck,
} from "./check-suite.js";
export {
  buildCheckSuiteEvent,
  buildCheckSuiteUrl,
  loadCheckSuiteFacts,
  needsCheckSuitePullRequestFacts,
  parseCheckSuiteFactsTarget,
  parseCheckSuitePublishTargets,
  selectFailingChecks,
} from "./check-suite.js";

/** The GitHub user who did what an Event describes, when GitHub names one. */
function gitHubDoneBy(
  login: string | undefined,
): Pick<EventInput, "doneBy"> | undefined {
  const handle = login?.trim();
  return handle ? { doneBy: { provider: "github", handle } } : undefined;
}

/**
 * Drop missing values from event data. A filter on a value that GitHub did not
 * send then does not match.
 */
function definedValues(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined),
  );
}

/** The text of a webhook value, or undefined when it is missing or blank. */
function nonBlank(value: string | null | undefined): string | undefined {
  return value?.trim() || undefined;
}

const repositorySchema = z
  .object({ full_name: z.string().min(1) })
  .passthrough();

// GitHub envelopes contain many additional fields; these schemas intentionally
// select only the fields used to produce Junior's canonical events.

const deploymentSchema = z
  .object({
    created_at: z.string().optional(),
    environment: z.string().min(1),
    id: z.number(),
    sha: z.string().regex(/^[0-9a-f]{40}$/i),
  })
  .passthrough();

// GitHub sends the workflow and its run only for deployments that GitHub
// Actions creates for a job with `environment:`.
const deploymentWorkflowSchema = {
  workflow: z
    .object({ id: z.number(), path: z.string().min(1) })
    .passthrough()
    .nullish(),
  workflow_run: z.object({ id: z.number() }).passthrough().nullish(),
};

const deploymentWebhookSchema = z
  .object({
    action: z.string(),
    deployment: deploymentSchema,
    repository: repositorySchema,
    ...deploymentWorkflowSchema,
  })
  .passthrough();
const canonicalDeploymentEventSchema = z
  .object({
    action: z.string(),
    commitSha: z.string().regex(/^[0-9a-f]{40}$/i),
    createdAt: z.string().optional(),
    deploymentId: z.number(),
    environment: z.string().min(1),
    repo: z.string().min(1),
    workflowId: z.number().optional(),
    workflowPath: z.string().min(1).optional(),
    workflowRunId: z.number().optional(),
  })
  .strict();

/** Select the canonical deployment fields shared by both webhook envelopes. */
function canonicalDeploymentFields(
  data: z.output<typeof deploymentWebhookSchema>,
) {
  return {
    action: data.action,
    commitSha: data.deployment.sha,
    createdAt: data.deployment.created_at,
    deploymentId: data.deployment.id,
    environment: data.deployment.environment,
    repo: data.repository.full_name,
    workflowId: data.workflow?.id,
    workflowPath: data.workflow?.path,
    workflowRunId: data.workflow_run?.id,
  };
}

/** Convert GitHub's permissive webhook envelope into routing-safe fields. */
function parseDeploymentEvent(body: unknown) {
  const parsed = deploymentWebhookSchema.safeParse(body);
  if (!parsed.success) return undefined;
  return canonicalDeploymentEventSchema.parse(
    canonicalDeploymentFields(parsed.data),
  );
}

/** Normalize a newly created GitHub deployment. */
function normalizeDeploymentEvent(
  deliveryId: string,
  body: unknown,
): EventInput[] {
  const parsed = parseDeploymentEvent(body);
  if (!parsed || parsed.action !== "created") return [];
  const eventType = "deployment.created";
  const { label } = gitHubDeploymentSourceResource(parsed);
  return deploymentTargets(parsed).map(({ identifier }) => ({
    eventKey: gitHubEventKey(deliveryId, eventType),
    eventType,
    occurredAtMs: providerTime(parsed.createdAt) ?? Date.now(),
    identifier,
    trustedSummary: `${label} was created (deployment ${parsed.deploymentId}).`,
    data: deploymentEventData(parsed),
  }));
}

const deploymentStatusWebhookSchema = deploymentWebhookSchema.extend({
  deployment_status: z
    .object({
      created_at: z.string().optional(),
      description: z.string().optional().nullable(),
      state: z.string(),
    })
    .passthrough(),
});
const canonicalDeploymentStatusEventSchema = canonicalDeploymentEventSchema
  .extend({
    description: z.string().optional().nullable(),
    state: z.string(),
    statusCreatedAt: z.string().optional(),
  })
  .strict();

/** Convert a GitHub status envelope into canonical deployment event fields. */
function parseDeploymentStatusEvent(body: unknown) {
  const parsed = deploymentStatusWebhookSchema.safeParse(body);
  if (!parsed.success) return undefined;
  return canonicalDeploymentStatusEventSchema.parse({
    ...canonicalDeploymentFields(parsed.data),
    description: parsed.data.deployment_status.description,
    state: parsed.data.deployment_status.state,
    statusCreatedAt: parsed.data.deployment_status.created_at,
  });
}

/** Map GitHub status vocabulary to Junior's deployment event contract. */
function deploymentStatusEventType(state: string): string | undefined {
  switch (state) {
    case "queued":
    case "pending":
    case "in_progress":
      return `deployment.${state}`;
    case "success":
      return "deployment.succeeded";
    case "failure":
      return "deployment.failed";
    case "error":
      return "deployment.error";
    default:
      return undefined;
  }
}

/** Normalize a GitHub deployment status into a source event. */
function normalizeDeploymentStatusEvent(
  deliveryId: string,
  body: unknown,
): EventInput[] {
  const parsed = parseDeploymentStatusEvent(body);
  if (!parsed || parsed.action !== "created") return [];
  const eventType = deploymentStatusEventType(parsed.state);
  if (!eventType) return [];
  const outcome =
    eventType === "deployment.succeeded"
      ? "succeeded"
      : eventType === "deployment.failed"
        ? "failed"
        : eventType === "deployment.error"
          ? "reported an error"
          : eventType === "deployment.in_progress"
            ? "started"
            : `is ${parsed.state}`;
  const terminal =
    eventType === "deployment.succeeded" ||
    eventType === "deployment.failed" ||
    eventType === "deployment.error";
  const { label } = gitHubDeploymentSourceResource(parsed);
  return deploymentTargets(parsed).map(
    ({ completeOnTerminalEvent, identifier }) => ({
      eventKey: gitHubEventKey(deliveryId, eventType),
      eventType,
      occurredAtMs: providerTime(parsed.statusCreatedAt) ?? Date.now(),
      identifier,
      ...(terminal && completeOnTerminalEvent ? { terminal: true } : undefined),
      trustedSummary: `${label} ${outcome} (deployment ${parsed.deploymentId}).`,
      data: deploymentEventData(parsed),
      untrustedText: parsed.description ?? undefined,
    }),
  );
}

/** Trusted deployment facts for match filters and the woken agent. */
function deploymentEventData(input: {
  environment: string;
  workflowId?: number;
  workflowPath?: string;
  workflowRunId?: number;
}) {
  return {
    environment: input.environment.toLowerCase(),
    ...(input.workflowId === undefined
      ? undefined
      : { workflowId: input.workflowId }),
    ...(input.workflowPath ? { workflowPath: input.workflowPath } : undefined),
    ...(input.workflowRunId === undefined
      ? undefined
      : { workflowRunId: input.workflowRunId }),
  };
}

/**
 * Address one deployment through its exact environment, its commit, and its
 * repository. Only the exact target completes on a terminal status; the
 * repository target lets event automations follow every deployment.
 */
function deploymentTargets(input: {
  commitSha: string;
  environment: string;
  repo: string;
}) {
  return [
    {
      completeOnTerminalEvent: true,
      identifier: gitHubDeploymentSourceResource(input).identifier,
    },
    {
      completeOnTerminalEvent: false,
      identifier: gitHubDeploymentSourceResource({
        commitSha: input.commitSha,
        repo: input.repo,
      }).identifier,
    },
    {
      completeOnTerminalEvent: false,
      identifier: gitHubRepositoryResource({ repo: input.repo }).identifier,
    },
  ];
}

const gitHubUserSchema = z.object({
  email: z.string().nullish(),
  login: z.string().nullish(),
});

/**
 * The user who sent a webhook. GitHub authenticates this user, so on a comment
 * or review it is the author. Match on the numeric id; logins can be renamed
 * and reused.
 */
const senderSchema = z.object({ id: z.number(), login: z.string().min(1) });

const commentSchema = z.object({
  body: z.string(),
  id: z.number(),
  user: z.object({ login: z.string().optional() }).optional(),
});

/** Trusted data that every comment and review event sets. */
const commentAuthorDataSchema = z.object({
  mentionsBot: z.boolean().optional(),
  senderId: z.number().optional(),
  senderLogin: z.string().min(1).optional(),
});

/**
 * Who wrote a comment or review, and whether its text mentions the bot.
 * `mentionsBot` is set only when the bot email is configured.
 */
function commentAuthorData(input: {
  botEmail: string | undefined;
  sender: z.output<typeof senderSchema> | undefined;
  text: string | null | undefined;
}) {
  return {
    mentionsBot: input.botEmail
      ? mentionsBotLogin(input.text ?? "", input.botEmail)
      : undefined,
    senderId: input.sender?.id,
    senderLogin: input.sender?.login,
  };
}

/** The pull request values that every pull request webhook sends. */
const pullRequestSchema = z.object({
  draft: z.boolean().optional(),
  head: z.object({ ref: z.string().nullish() }).nullish(),
  number: z.number(),
  user: gitHubUserSchema.nullish(),
});

/**
 * Trusted data on every pull request event. The opener is the GitHub user
 * who opened the pull request, not the commenter. The pull request comment
 * webhook has no head branch.
 */
const pullRequestEventDataSchema = commentAuthorDataSchema
  .extend({
    repo: z.string().min(1),
    pullRequest: z.number(),
    headBranch: z.string().min(1).optional(),
    isDraft: z.boolean().optional(),
    openerEmail: z.string().min(1).optional(),
    openerUsername: z.string().min(1).optional(),
    commentId: z.number().optional(),
    commentKind: z.enum(["conversation", "review"]).optional(),
  })
  .strict();

/** Build the trusted data of one pull request event. */
function pullRequestEventData(input: {
  comment?: Omit<
    z.input<typeof pullRequestEventDataSchema>,
    "pullRequest" | "repo"
  >;
  pullRequest: z.output<typeof pullRequestSchema>;
  repo: string;
}): Record<string, unknown> {
  const { pullRequest } = input;
  return pullRequestEventDataSchema.parse(
    definedValues({
      repo: input.repo,
      pullRequest: pullRequest.number,
      headBranch: nonBlank(pullRequest.head?.ref),
      isDraft: pullRequest.draft,
      openerEmail: nonBlank(pullRequest.user?.email),
      openerUsername: nonBlank(pullRequest.user?.login),
      ...input.comment,
    }),
  );
}

/** Trusted data on every issue event. */
const issueEventDataSchema = commentAuthorDataSchema
  .extend({
    repo: z.string().min(1),
    issue: z.number(),
    commentId: z.number().optional(),
  })
  .strict();

/** Build the trusted data of one issue event. */
function issueEventData(
  input: z.input<typeof issueEventDataSchema>,
): Record<string, unknown> {
  return issueEventDataSchema.parse(definedValues(input));
}

const issueCommentWebhookSchema = z.object({
  action: z.string(),
  comment: commentSchema,
  issue: z.object({
    draft: z.boolean().optional(),
    number: z.number(),
    pull_request: z.object({ url: z.string().min(1) }).optional(),
    user: gitHubUserSchema.nullish(),
  }),
  repository: repositorySchema,
  sender: senderSchema.optional(),
});

/** Normalize a newly created issue or pull request comment. */
function normalizeIssueCommentEvents(
  deliveryId: string,
  body: unknown,
  botEmail: string | undefined,
): EventInput[] {
  const parsed = issueCommentWebhookSchema.safeParse(body);
  if (!parsed.success || parsed.data.action !== "created") return [];
  const { comment, issue, sender } = parsed.data;
  const author = comment.user?.login;
  if (isBotLogin(author, botEmail)) return [];
  const input = {
    number: issue.number,
    repo: parsed.data.repository.full_name,
  };
  const writtenBy = commentAuthorData({ botEmail, sender, text: comment.body });
  if (issue.pull_request) {
    const eventType = "pull_request.comment.created";
    const resource = gitHubPullRequestResource(input);
    return pullRequestTargets(
      {
        eventKey: gitHubEventKey(deliveryId, eventType),
        eventType,
        occurredAtMs: Date.now(),
        identifier: resource.identifier,
        trustedSummary: `${resource.label} received a comment${author ? ` from ${author}` : ""}.`,
        ...gitHubDoneBy(author),
        data: pullRequestEventData({
          comment: {
            commentId: comment.id,
            commentKind: "conversation",
            ...writtenBy,
          },
          pullRequest: issue,
          repo: input.repo,
        }),
        untrustedText: comment.body,
      },
      input.repo,
    );
  }

  const issueResource = gitHubIssueResource(input);
  const repository = gitHubRepositoryResource(input);
  const data = issueEventData({
    repo: input.repo,
    issue: input.number,
    commentId: comment.id,
    ...writtenBy,
  });
  return [issueResource, repository].map((resource) => ({
    eventKey: gitHubEventKey(deliveryId, "issue.comment.created"),
    eventType: "issue.comment.created",
    occurredAtMs: Date.now(),
    identifier: resource.identifier,
    trustedSummary: `${issueResource.label} received a comment${author ? ` from ${author}` : ""}.`,
    ...gitHubDoneBy(author),
    data,
    untrustedText: comment.body,
  }));
}

const issueWebhookSchema = z.object({
  action: z.string(),
  issue: z.object({
    body: z.string().optional().nullable(),
    closed_at: z.string().optional().nullable(),
    created_at: z.string().optional(),
    number: z.number(),
    title: z.string().optional(),
    updated_at: z.string().optional(),
  }),
  repository: repositorySchema,
});

/** The title and body of an issue or pull request, as untrusted text. */
function titleAndBodyText(item: {
  body?: string | null;
  title?: string;
}): string | undefined {
  const parts = [
    item.title ? `Title: ${item.title}` : undefined,
    nonBlank(item.body),
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** Normalize issue lifecycle changes for the issue and its repository. */
function normalizeIssueEvents(deliveryId: string, body: unknown): EventInput[] {
  const parsed = issueWebhookSchema.safeParse(body);
  if (!parsed.success) return [];
  const state =
    parsed.data.action === "opened"
      ? "opened"
      : parsed.data.action === "closed"
        ? "closed"
        : parsed.data.action === "reopened"
          ? "reopened"
          : undefined;
  if (!state) return [];

  const input = {
    number: parsed.data.issue.number,
    repo: parsed.data.repository.full_name,
  };
  const issue = gitHubIssueResource(input);
  const repository = gitHubRepositoryResource(input);
  const occurredAtMs =
    providerTime(
      state === "opened"
        ? parsed.data.issue.created_at
        : state === "closed"
          ? parsed.data.issue.closed_at
          : parsed.data.issue.updated_at,
    ) ?? Date.now();
  const data = issueEventData({ repo: input.repo, issue: input.number });
  const untrustedText = titleAndBodyText(parsed.data.issue);
  return [issue, repository].map((resource) => ({
    eventKey: gitHubEventKey(deliveryId, `issue.${state}`),
    eventType: `issue.${state}`,
    occurredAtMs,
    identifier: resource.identifier,
    trustedSummary: `${issue.label} was ${state}.`,
    data,
    ...(untrustedText ? { untrustedText } : undefined),
  }));
}

const pullRequestReviewCommentWebhookSchema = z.object({
  action: z.string(),
  comment: commentSchema,
  pull_request: pullRequestSchema,
  repository: repositorySchema,
  sender: senderSchema.optional(),
});

/** Normalize a newly created inline pull request review comment. */
function normalizePullRequestReviewCommentEvent(
  deliveryId: string,
  body: unknown,
  botEmail: string | undefined,
): EventInput[] {
  const parsed = pullRequestReviewCommentWebhookSchema.safeParse(body);
  if (!parsed.success || parsed.data.action !== "created") return [];
  const { comment, pull_request: pullRequest, sender } = parsed.data;
  const author = comment.user?.login;
  if (isBotLogin(author, botEmail)) return [];
  const eventType = "pull_request.review_comment.created";
  const repo = parsed.data.repository.full_name;
  const resource = gitHubPullRequestResource({
    number: pullRequest.number,
    repo,
  });
  return pullRequestTargets(
    {
      eventKey: gitHubEventKey(deliveryId, eventType),
      eventType,
      occurredAtMs: Date.now(),
      identifier: resource.identifier,
      trustedSummary: `${resource.label} received an inline review comment${author ? ` from ${author}` : ""}.`,
      ...gitHubDoneBy(author),
      data: pullRequestEventData({
        comment: {
          commentId: comment.id,
          commentKind: "review",
          ...commentAuthorData({ botEmail, sender, text: comment.body }),
        },
        pullRequest,
        repo,
      }),
      untrustedText: comment.body,
    },
    repo,
  );
}

const pullRequestReviewWebhookSchema = z.object({
  action: z.string(),
  pull_request: pullRequestSchema,
  repository: repositorySchema,
  review: z.object({
    body: z.string().optional().nullable(),
    state: z.string(),
    user: z.object({ login: z.string().optional() }).optional(),
  }),
  sender: senderSchema.optional(),
});

/** Normalize a submitted pull request review into its review-state event. */
function normalizePullRequestReviewEvent(
  deliveryId: string,
  body: unknown,
  botEmail: string | undefined,
): EventInput[] {
  const parsed = pullRequestReviewWebhookSchema.safeParse(body);
  if (!parsed.success || parsed.data.action !== "submitted") return [];
  const { pull_request: pullRequest, review, sender } = parsed.data;
  if (isBotLogin(review.user?.login, botEmail)) return [];
  const reviewState = review.state.toUpperCase();
  const eventType =
    reviewState === "APPROVED"
      ? "pull_request.review.approved"
      : reviewState === "CHANGES_REQUESTED"
        ? "pull_request.review.changes_requested"
        : reviewState === "COMMENTED"
          ? "pull_request.review.commented"
          : undefined;
  if (!eventType) return [];
  const repo = parsed.data.repository.full_name;
  const resource = gitHubPullRequestResource({
    number: pullRequest.number,
    repo,
  });
  const reviewer = review.user?.login;
  const event: EventInput = {
    eventKey: gitHubEventKey(deliveryId, eventType),
    eventType,
    occurredAtMs: Date.now(),
    identifier: resource.identifier,
    trustedSummary:
      eventType === "pull_request.review.approved"
        ? `${resource.label} was approved${reviewer ? ` by ${reviewer}` : ""}.`
        : eventType === "pull_request.review.changes_requested"
          ? `${resource.label} received requested changes${reviewer ? ` from ${reviewer}` : ""}.`
          : `${resource.label} received a review comment${reviewer ? ` from ${reviewer}` : ""}.`,
    ...gitHubDoneBy(reviewer),
    data: pullRequestEventData({
      comment: commentAuthorData({ botEmail, sender, text: review.body }),
      pullRequest,
      repo,
    }),
    untrustedText: review.body ?? undefined,
  };
  const events = pullRequestTargets(event, repo);
  if (eventType !== "pull_request.review.approved" || !nonBlank(review.body)) {
    return events;
  }
  // Also deliver an approval's comment to subscriptions that skip approvals.
  return [
    ...events,
    ...pullRequestTargets(
      {
        ...event,
        eventKey: gitHubEventKey(deliveryId, "pull_request.review.commented"),
        eventType: "pull_request.review.commented",
      },
      repo,
    ),
  ];
}

const pullRequestWebhookSchema = z.object({
  action: z.string(),
  pull_request: pullRequestSchema.extend({
    body: z.string().optional().nullable(),
    closed_at: z.string().optional().nullable(),
    created_at: z.string().optional(),
    merged: z.boolean().optional(),
    merged_at: z.string().optional().nullable(),
    title: z.string().optional(),
    updated_at: z.string().optional(),
  }),
  repository: repositorySchema,
});

/** Convert an optional provider timestamp for receipt-time fallback ordering. */
function providerTime(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Normalize pull request opened, ready-for-review, and terminal lifecycle events. */
function normalizePullRequestEvent(
  deliveryId: string,
  body: unknown,
): EventInput[] {
  const parsed = pullRequestWebhookSchema.safeParse(body);
  if (!parsed.success) return [];

  const { pull_request: pullRequest } = parsed.data;
  const repo = parsed.data.repository.full_name;
  const resource = gitHubPullRequestResource({
    number: pullRequest.number,
    repo,
  });
  const data = pullRequestEventData({ pullRequest, repo });
  const untrustedText = titleAndBodyText(pullRequest);
  const lifecycleEvents = (event: {
    eventType: string;
    isDraft?: false;
    occurredAtMs: number;
    terminal?: true;
    trustedSummary: string;
    untrustedText?: string;
  }): EventInput[] =>
    pullRequestTargets(
      {
        eventKey: gitHubEventKey(deliveryId, event.eventType),
        eventType: event.eventType,
        occurredAtMs: event.occurredAtMs,
        identifier: resource.identifier,
        ...(event.terminal ? { terminal: true } : undefined),
        trustedSummary: event.trustedSummary,
        data: event.isDraft === false ? { ...data, isDraft: false } : data,
        ...(event.untrustedText
          ? { untrustedText: event.untrustedText }
          : undefined),
      },
      repo,
    );

  if (parsed.data.action === "opened") {
    const openedAtMs = providerTime(pullRequest.created_at) ?? Date.now();
    const events = lifecycleEvents({
      eventType: "pull_request.opened",
      occurredAtMs: openedAtMs,
      trustedSummary: `${resource.label} was opened.`,
      untrustedText,
    });
    // Non-draft opens are immediately reviewable; emit the same signal used
    // when a draft later leaves draft state.
    if (pullRequest.draft !== true) {
      events.push(
        ...lifecycleEvents({
          eventType: "pull_request.ready_for_review",
          isDraft: false,
          occurredAtMs: openedAtMs,
          trustedSummary: `${resource.label} is ready for review.`,
          untrustedText,
        }),
      );
    }
    return events;
  }

  if (parsed.data.action === "ready_for_review") {
    return lifecycleEvents({
      eventType: "pull_request.ready_for_review",
      isDraft: false,
      occurredAtMs: providerTime(pullRequest.updated_at) ?? Date.now(),
      trustedSummary: `${resource.label} is ready for review.`,
      untrustedText,
    });
  }

  if (parsed.data.action !== "closed") return [];
  const eventType = pullRequest.merged
    ? "pull_request.merged"
    : "pull_request.closed_unmerged";
  return lifecycleEvents({
    eventType,
    occurredAtMs:
      providerTime(
        pullRequest.merged ? pullRequest.merged_at : pullRequest.closed_at,
      ) ?? Date.now(),
    terminal: true,
    trustedSummary:
      eventType === "pull_request.merged"
        ? `${resource.label} was merged.`
        : `${resource.label} was closed without being merged.`,
  });
}

const releaseWebhookSchema = z
  .object({
    action: z.string(),
    release: z
      .object({
        body: z.string().optional().nullable(),
        draft: z.boolean().optional(),
        id: z.number(),
        name: z.string().optional().nullable(),
        prerelease: z.boolean().optional(),
        published_at: z.string().optional().nullable(),
        tag_name: z.string().min(1),
      })
      .passthrough(),
    repository: repositorySchema,
  })
  .passthrough();

/** Address one release through both its exact tag and its repository. */
function releaseSourceTargets(input: { repo: string; tag: string }) {
  return [
    {
      completeOnTerminalEvent: true,
      resource: gitHubReleaseSourceResource(input),
    },
    {
      completeOnTerminalEvent: false,
      resource: gitHubReleaseSourceResource({ repo: input.repo }),
    },
  ];
}

/** Normalize a published GitHub release for tag and repository watches. */
function normalizeReleaseEvent(
  deliveryId: string,
  body: unknown,
): EventInput[] {
  const parsed = releaseWebhookSchema.safeParse(body);
  if (!parsed.success || parsed.data.action !== "published") return [];
  if (parsed.data.release.draft) return [];
  const eventType = "release.published";
  const repo = parsed.data.repository.full_name;
  const tag = parsed.data.release.tag_name;
  const untrustedParts = [
    tag ? `Tag: ${tag}` : undefined,
    parsed.data.release.name?.trim()
      ? `Name: ${parsed.data.release.name.trim()}`
      : undefined,
    parsed.data.release.body?.trim() || undefined,
  ].filter((part): part is string => part !== undefined);
  const untrustedText =
    untrustedParts.length > 0 ? untrustedParts.join("\n\n") : undefined;
  return releaseSourceTargets({ repo, tag }).map(
    ({ completeOnTerminalEvent, resource }) => ({
      eventKey: gitHubEventKey(deliveryId, eventType),
      eventType,
      occurredAtMs:
        providerTime(parsed.data.release.published_at) ?? Date.now(),
      identifier: resource.identifier,
      ...(completeOnTerminalEvent ? { terminal: true } : undefined),
      trustedSummary: `${resource.label} was published (release ${parsed.data.release.id}).`,
      ...(untrustedText ? { untrustedText } : undefined),
    }),
  );
}

/**
 * Normalize one verified GitHub delivery into conversation events.
 *
 * Comments and reviews written by the configured bot are dropped, so Junior
 * does not react to or act on its own feedback.
 */
export function normalizeGitHubEvents(args: {
  body: unknown;
  botEmail?: string;
  checkSuiteFacts?: GitHubCheckSuiteFacts;
  deliveryId: string;
  eventName: string;
}): EventInput[] {
  switch (args.eventName) {
    case "deployment":
      return normalizeDeploymentEvent(args.deliveryId, args.body);
    case "deployment_status":
      return normalizeDeploymentStatusEvent(args.deliveryId, args.body);
    case "pull_request":
      return normalizePullRequestEvent(args.deliveryId, args.body);
    case "issues":
      return normalizeIssueEvents(args.deliveryId, args.body);
    case "pull_request_review":
      return normalizePullRequestReviewEvent(
        args.deliveryId,
        args.body,
        args.botEmail,
      );
    case "issue_comment":
      return normalizeIssueCommentEvents(
        args.deliveryId,
        args.body,
        args.botEmail,
      );
    case "pull_request_review_comment":
      return normalizePullRequestReviewCommentEvent(
        args.deliveryId,
        args.body,
        args.botEmail,
      );
    case "check_suite":
      return normalizeCheckSuiteEvents(
        args.deliveryId,
        args.body,
        args.checkSuiteFacts,
      );
    case "release":
      return normalizeReleaseEvent(args.deliveryId, args.body);
    default:
      return [];
  }
}
