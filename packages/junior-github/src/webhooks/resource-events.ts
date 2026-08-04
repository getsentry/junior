import type { ResourceEventInput } from "@sentry/junior-plugin-api";
import { z } from "zod";
import { gitHubDeploymentSourceResource } from "../resource-events/deployment.js";
import { gitHubIssueResource } from "../resource-events/issue.js";
import { gitHubPullRequestResource } from "../resource-events/pull-request.js";
import { gitHubReleaseSourceResource } from "../resource-events/release.js";
import { gitHubRepositoryResource } from "../resource-events/repository.js";

function gitHubEventKey(deliveryId: string, eventType: string): string {
  return `github:${deliveryId}:${eventType}`;
}

const repositorySchema = z
  .object({ full_name: z.string().min(1) })
  .passthrough();

// GitHub envelopes contain many additional fields; these schemas intentionally
// select only the fields used to produce Junior's canonical resource events.

const deploymentSchema = z
  .object({
    created_at: z.string().optional(),
    environment: z.string().min(1),
    id: z.number(),
    sha: z.string().regex(/^[0-9a-f]{40}$/i),
  })
  .passthrough();

const deploymentWebhookSchema = z
  .object({
    action: z.string(),
    deployment: deploymentSchema,
    repository: repositorySchema,
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
  })
  .strict();

/** Convert GitHub's permissive webhook envelope into routing-safe fields. */
function parseDeploymentEvent(body: unknown) {
  const parsed = deploymentWebhookSchema.safeParse(body);
  if (!parsed.success) return undefined;
  return canonicalDeploymentEventSchema.parse({
    action: parsed.data.action,
    commitSha: parsed.data.deployment.sha,
    createdAt: parsed.data.deployment.created_at,
    deploymentId: parsed.data.deployment.id,
    environment: parsed.data.deployment.environment,
    repo: parsed.data.repository.full_name,
  });
}

/** Normalize a newly created GitHub deployment. */
function normalizeDeploymentEvent(
  deliveryId: string,
  body: unknown,
): ResourceEventInput[] {
  const parsed = parseDeploymentEvent(body);
  if (!parsed || parsed.action !== "created") return [];
  const eventType = "deployment.created";
  return deploymentSourceTargets(parsed).map(({ resource }) => ({
    eventKey: gitHubEventKey(deliveryId, eventType),
    eventType,
    occurredAtMs: providerTime(parsed.createdAt) ?? Date.now(),
    identifier: resource.identifier,
    trustedSummary: `${resource.label} was created (deployment ${parsed.deploymentId}).`,
  }));
}

const deploymentStatusWebhookSchema = z
  .object({
    action: z.string(),
    deployment: deploymentSchema,
    deployment_status: z
      .object({
        created_at: z.string().optional(),
        description: z.string().optional().nullable(),
        state: z.string(),
      })
      .passthrough(),
    repository: repositorySchema,
  })
  .passthrough();
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
    action: parsed.data.action,
    commitSha: parsed.data.deployment.sha,
    createdAt: parsed.data.deployment.created_at,
    deploymentId: parsed.data.deployment.id,
    description: parsed.data.deployment_status.description,
    environment: parsed.data.deployment.environment,
    repo: parsed.data.repository.full_name,
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
): ResourceEventInput[] {
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
  return deploymentSourceTargets(parsed).map(
    ({ completeOnTerminalEvent, resource }) => ({
      eventKey: gitHubEventKey(deliveryId, eventType),
      eventType,
      occurredAtMs: providerTime(parsed.statusCreatedAt) ?? Date.now(),
      identifier: resource.identifier,
      ...(terminal && completeOnTerminalEvent ? { terminal: true } : {}),
      trustedSummary: `${resource.label} ${outcome} (deployment ${parsed.deploymentId}).`,
      untrustedText: parsed.description ?? undefined,
    }),
  );
}

/** Address one deployment through both its exact environment and its commit. */
function deploymentSourceTargets(input: {
  commitSha: string;
  environment: string;
  repo: string;
}) {
  return [
    {
      completeOnTerminalEvent: true,
      resource: gitHubDeploymentSourceResource(input),
    },
    {
      completeOnTerminalEvent: false,
      resource: gitHubDeploymentSourceResource({
        commitSha: input.commitSha,
        repo: input.repo,
      }),
    },
  ];
}

const checkSuiteWebhookSchema = z.object({
  action: z.string(),
  check_suite: z.object({
    conclusion: z.string().optional().nullable(),
    head_sha: z.string().optional(),
    pull_requests: z.array(z.object({ number: z.number() })),
  }),
  repository: repositorySchema,
});

/** Normalize a completed check suite for each attached pull request. */
function normalizeCheckSuiteEvents(
  deliveryId: string,
  body: unknown,
): ResourceEventInput[] {
  const parsed = checkSuiteWebhookSchema.safeParse(body);
  if (!parsed.success || parsed.data.action !== "completed") return [];
  const conclusion = parsed.data.check_suite.conclusion;
  const eventType =
    conclusion === "failure" || conclusion === "timed_out"
      ? "pull_request.checks.failed"
      : conclusion === "success"
        ? "pull_request.checks.recovered"
        : undefined;
  if (!eventType) return [];
  const sha = parsed.data.check_suite.head_sha?.slice(0, 12);
  return parsed.data.check_suite.pull_requests.map((pullRequest) => {
    const resource = gitHubPullRequestResource({
      number: pullRequest.number,
      repo: parsed.data.repository.full_name,
    });
    return {
      eventKey: gitHubEventKey(
        deliveryId,
        `${eventType}:${pullRequest.number}`,
      ),
      eventType,
      occurredAtMs: Date.now(),
      identifier: resource.identifier,
      trustedSummary:
        eventType === "pull_request.checks.failed"
          ? `${resource.label} checks failed${sha ? ` for ${sha}` : ""}.`
          : `${resource.label} checks recovered${sha ? ` for ${sha}` : ""}.`,
    };
  });
}

const issueCommentWebhookSchema = z.object({
  action: z.string(),
  comment: z.object({
    body: z.string(),
    user: z.object({ login: z.string().optional() }).optional(),
  }),
  issue: z.object({
    number: z.number(),
    pull_request: z.object({ url: z.string().min(1) }).optional(),
  }),
  repository: repositorySchema,
});

/** Normalize a newly created issue or pull request comment. */
function normalizeIssueCommentEvents(
  deliveryId: string,
  body: unknown,
): ResourceEventInput[] {
  const parsed = issueCommentWebhookSchema.safeParse(body);
  if (!parsed.success || parsed.data.action !== "created") return [];
  const input = {
    number: parsed.data.issue.number,
    repo: parsed.data.repository.full_name,
  };
  const author = parsed.data.comment.user?.login;
  if (parsed.data.issue.pull_request) {
    const eventType = "pull_request.comment.created";
    const resource = gitHubPullRequestResource(input);
    return [
      {
        eventKey: gitHubEventKey(deliveryId, eventType),
        eventType,
        occurredAtMs: Date.now(),
        identifier: resource.identifier,
        trustedSummary: `${resource.label} received a comment${author ? ` from ${author}` : ""}.`,
        untrustedText: parsed.data.comment.body,
      },
    ];
  }

  const issue = gitHubIssueResource(input);
  const repository = gitHubRepositoryResource(input);
  return [
    {
      eventKey: gitHubEventKey(deliveryId, "issue.comment.created"),
      eventType: "issue.comment.created",
      occurredAtMs: Date.now(),
      identifier: issue.identifier,
      trustedSummary: `${issue.label} received a comment${author ? ` from ${author}` : ""}.`,
      untrustedText: parsed.data.comment.body,
    },
    {
      eventKey: gitHubEventKey(deliveryId, "issue.comment.created"),
      eventType: "issue.comment.created",
      occurredAtMs: Date.now(),
      identifier: repository.identifier,
      trustedSummary: `${issue.label} received a comment${author ? ` from ${author}` : ""}.`,
      untrustedText: parsed.data.comment.body,
    },
  ];
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

function issueEventText(issue: {
  body?: string | null;
  title?: string;
}): string | undefined {
  const parts = [
    issue.title ? `Title: ${issue.title}` : undefined,
    issue.body?.trim() || undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** Normalize issue lifecycle changes for the issue and its repository. */
function normalizeIssueEvents(
  deliveryId: string,
  body: unknown,
): ResourceEventInput[] {
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
  const untrustedText = issueEventText(parsed.data.issue);
  return [
    {
      eventKey: gitHubEventKey(deliveryId, `issue.${state}`),
      eventType: `issue.${state}`,
      occurredAtMs,
      identifier: issue.identifier,
      trustedSummary: `${issue.label} was ${state}.`,
      ...(untrustedText ? { untrustedText } : {}),
    },
    {
      eventKey: gitHubEventKey(deliveryId, `issue.${state}`),
      eventType: `issue.${state}`,
      occurredAtMs,
      identifier: repository.identifier,
      trustedSummary: `${issue.label} was ${state}.`,
      ...(untrustedText ? { untrustedText } : {}),
    },
  ];
}

const pullRequestReviewCommentWebhookSchema = z.object({
  action: z.string(),
  comment: z.object({
    body: z.string(),
    user: z.object({ login: z.string().optional() }).optional(),
  }),
  pull_request: z.object({ number: z.number() }),
  repository: repositorySchema,
});

/** Normalize a newly created inline pull request review comment. */
function normalizePullRequestReviewCommentEvent(
  deliveryId: string,
  body: unknown,
): ResourceEventInput | undefined {
  const parsed = pullRequestReviewCommentWebhookSchema.safeParse(body);
  if (!parsed.success || parsed.data.action !== "created") return undefined;
  const eventType = "pull_request.review_comment.created";
  const resource = gitHubPullRequestResource({
    number: parsed.data.pull_request.number,
    repo: parsed.data.repository.full_name,
  });
  const author = parsed.data.comment.user?.login;
  return {
    eventKey: gitHubEventKey(deliveryId, eventType),
    eventType,
    occurredAtMs: Date.now(),
    identifier: resource.identifier,
    trustedSummary: `${resource.label} received an inline review comment${author ? ` from ${author}` : ""}.`,
    untrustedText: parsed.data.comment.body,
  };
}

const pullRequestReviewWebhookSchema = z.object({
  action: z.string(),
  pull_request: z.object({ number: z.number() }),
  repository: repositorySchema,
  review: z.object({
    body: z.string().optional().nullable(),
    state: z.string(),
    user: z.object({ login: z.string().optional() }).optional(),
  }),
});

/** Normalize a submitted pull request review into its review-state event. */
function normalizePullRequestReviewEvent(
  deliveryId: string,
  body: unknown,
): ResourceEventInput | undefined {
  const parsed = pullRequestReviewWebhookSchema.safeParse(body);
  if (!parsed.success || parsed.data.action !== "submitted") return undefined;
  const reviewState = parsed.data.review.state.toUpperCase();
  const eventType =
    reviewState === "APPROVED"
      ? "pull_request.review.approved"
      : reviewState === "CHANGES_REQUESTED"
        ? "pull_request.review.changes_requested"
        : reviewState === "COMMENTED"
          ? "pull_request.review.commented"
          : undefined;
  if (!eventType) return undefined;
  const resource = gitHubPullRequestResource({
    number: parsed.data.pull_request.number,
    repo: parsed.data.repository.full_name,
  });
  const reviewer = parsed.data.review.user?.login;
  return {
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
    untrustedText: parsed.data.review.body ?? undefined,
  };
}

const pullRequestWebhookSchema = z.object({
  action: z.string(),
  pull_request: z.object({
    closed_at: z.string().optional().nullable(),
    merged: z.boolean().optional(),
    merged_at: z.string().optional().nullable(),
    number: z.number(),
  }),
  repository: repositorySchema,
});

/** Convert an optional provider timestamp for receipt-time fallback ordering. */
function providerTime(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Normalize a terminal pull request lifecycle event. */
function normalizePullRequestEvent(
  deliveryId: string,
  body: unknown,
): ResourceEventInput | undefined {
  const parsed = pullRequestWebhookSchema.safeParse(body);
  if (!parsed.success || parsed.data.action !== "closed") return undefined;
  const eventType = parsed.data.pull_request.merged
    ? "pull_request.merged"
    : "pull_request.closed_unmerged";
  const resource = gitHubPullRequestResource({
    number: parsed.data.pull_request.number,
    repo: parsed.data.repository.full_name,
  });
  return {
    eventKey: gitHubEventKey(deliveryId, eventType),
    eventType,
    occurredAtMs:
      providerTime(
        parsed.data.pull_request.merged
          ? parsed.data.pull_request.merged_at
          : parsed.data.pull_request.closed_at,
      ) ?? Date.now(),
    identifier: resource.identifier,
    terminal: true,
    trustedSummary:
      eventType === "pull_request.merged"
        ? `${resource.label} was merged.`
        : `${resource.label} was closed without being merged.`,
  };
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
): ResourceEventInput[] {
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
      ...(completeOnTerminalEvent ? { terminal: true } : {}),
      trustedSummary: `${resource.label} was published (release ${parsed.data.release.id}).`,
      ...(untrustedText ? { untrustedText } : {}),
    }),
  );
}

/** Normalize one verified GitHub delivery into conversation resource events. */
export function normalizeGitHubResourceEvents(args: {
  body: unknown;
  deliveryId: string;
  eventName: string;
}): ResourceEventInput[] {
  switch (args.eventName) {
    case "deployment": {
      return normalizeDeploymentEvent(args.deliveryId, args.body);
    }
    case "deployment_status": {
      return normalizeDeploymentStatusEvent(args.deliveryId, args.body);
    }
    case "pull_request": {
      const event = normalizePullRequestEvent(args.deliveryId, args.body);
      return event ? [event] : [];
    }
    case "issues": {
      return normalizeIssueEvents(args.deliveryId, args.body);
    }
    case "pull_request_review": {
      const event = normalizePullRequestReviewEvent(args.deliveryId, args.body);
      return event ? [event] : [];
    }
    case "issue_comment": {
      return normalizeIssueCommentEvents(args.deliveryId, args.body);
    }
    case "pull_request_review_comment": {
      const event = normalizePullRequestReviewCommentEvent(
        args.deliveryId,
        args.body,
      );
      return event ? [event] : [];
    }
    case "check_suite":
      return normalizeCheckSuiteEvents(args.deliveryId, args.body);
    case "release":
      return normalizeReleaseEvent(args.deliveryId, args.body);
    default:
      return [];
  }
}
