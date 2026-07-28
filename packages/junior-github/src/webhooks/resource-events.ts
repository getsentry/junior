import type { ResourceEvent } from "@sentry/junior-plugin-api";
import { z } from "zod";
import { gitHubDeploymentSourceResource } from "../resource-events/deployment.js";
import { gitHubPullRequestResource } from "../resource-events/pull-request.js";

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
): ResourceEvent | undefined {
  const parsed = parseDeploymentEvent(body);
  if (!parsed || parsed.action !== "created") return undefined;
  const resource = gitHubDeploymentSourceResource({
    commitSha: parsed.commitSha,
    environment: parsed.environment,
    repo: parsed.repo,
  });
  const eventType = "deployment.created";
  return {
    eventKey: gitHubEventKey(deliveryId, eventType),
    eventType,
    occurredAtMs: providerTime(parsed.createdAt) ?? Date.now(),
    provider: "github",
    resourceRef: resource.resourceRef,
    trustedSummary: `${resource.label} was created (deployment ${parsed.deploymentId}).`,
  };
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
): ResourceEvent | undefined {
  const parsed = parseDeploymentStatusEvent(body);
  if (!parsed || parsed.action !== "created") return undefined;
  const eventType = deploymentStatusEventType(parsed.state);
  if (!eventType) return undefined;
  const resource = gitHubDeploymentSourceResource({
    commitSha: parsed.commitSha,
    environment: parsed.environment,
    repo: parsed.repo,
  });
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
  return {
    eventKey: gitHubEventKey(deliveryId, eventType),
    eventType,
    occurredAtMs: providerTime(parsed.statusCreatedAt) ?? Date.now(),
    provider: "github",
    resourceRef: resource.resourceRef,
    ...(terminal ? { terminal: true } : {}),
    trustedSummary: `${resource.label} ${outcome} (deployment ${parsed.deploymentId}).`,
    untrustedText: parsed.description ?? undefined,
  };
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
): ResourceEvent[] {
  const parsed = checkSuiteWebhookSchema.safeParse(body);
  if (!parsed.success || parsed.data.action !== "completed") return [];
  const conclusion = parsed.data.check_suite.conclusion;
  const eventType =
    conclusion === "failure" || conclusion === "timed_out"
      ? "checks.failed"
      : conclusion === "success"
        ? "checks.recovered"
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
      provider: "github",
      resourceRef: resource.resourceRef,
      trustedSummary:
        eventType === "checks.failed"
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

/** Normalize a newly created issue comment only when it belongs to a PR. */
function normalizeIssueCommentEvent(
  deliveryId: string,
  body: unknown,
): ResourceEvent | undefined {
  const parsed = issueCommentWebhookSchema.safeParse(body);
  if (
    !parsed.success ||
    parsed.data.action !== "created" ||
    !parsed.data.issue.pull_request
  ) {
    return undefined;
  }
  const eventType = "comment.created";
  const resource = gitHubPullRequestResource({
    number: parsed.data.issue.number,
    repo: parsed.data.repository.full_name,
  });
  const author = parsed.data.comment.user?.login;
  return {
    eventKey: gitHubEventKey(deliveryId, eventType),
    eventType,
    occurredAtMs: Date.now(),
    provider: "github",
    resourceRef: resource.resourceRef,
    trustedSummary: `${resource.label} received a comment${author ? ` from ${author}` : ""}.`,
    untrustedText: parsed.data.comment.body,
  };
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
): ResourceEvent | undefined {
  const parsed = pullRequestReviewCommentWebhookSchema.safeParse(body);
  if (!parsed.success || parsed.data.action !== "created") return undefined;
  const eventType = "review_comment.created";
  const resource = gitHubPullRequestResource({
    number: parsed.data.pull_request.number,
    repo: parsed.data.repository.full_name,
  });
  const author = parsed.data.comment.user?.login;
  return {
    eventKey: gitHubEventKey(deliveryId, eventType),
    eventType,
    occurredAtMs: Date.now(),
    provider: "github",
    resourceRef: resource.resourceRef,
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
): ResourceEvent | undefined {
  const parsed = pullRequestReviewWebhookSchema.safeParse(body);
  if (!parsed.success || parsed.data.action !== "submitted") return undefined;
  const reviewState = parsed.data.review.state.toUpperCase();
  const eventType =
    reviewState === "APPROVED"
      ? "review.approved"
      : reviewState === "CHANGES_REQUESTED"
        ? "review.changes_requested"
        : reviewState === "COMMENTED"
          ? "review.commented"
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
    provider: "github",
    resourceRef: resource.resourceRef,
    trustedSummary:
      eventType === "review.approved"
        ? `${resource.label} was approved${reviewer ? ` by ${reviewer}` : ""}.`
        : eventType === "review.changes_requested"
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
): ResourceEvent | undefined {
  const parsed = pullRequestWebhookSchema.safeParse(body);
  if (!parsed.success || parsed.data.action !== "closed") return undefined;
  const eventType = parsed.data.pull_request.merged
    ? "state.merged"
    : "state.closed_unmerged";
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
    provider: "github",
    resourceRef: resource.resourceRef,
    terminal: true,
    trustedSummary:
      eventType === "state.merged"
        ? `${resource.label} was merged.`
        : `${resource.label} was closed without being merged.`,
  };
}

/** Normalize one verified GitHub delivery into conversation resource events. */
export function normalizeGitHubResourceEvents(args: {
  body: unknown;
  deliveryId: string;
  eventName: string;
}): ResourceEvent[] {
  switch (args.eventName) {
    case "deployment": {
      const event = normalizeDeploymentEvent(args.deliveryId, args.body);
      return event ? [event] : [];
    }
    case "deployment_status": {
      const event = normalizeDeploymentStatusEvent(args.deliveryId, args.body);
      return event ? [event] : [];
    }
    case "pull_request": {
      const event = normalizePullRequestEvent(args.deliveryId, args.body);
      return event ? [event] : [];
    }
    case "pull_request_review": {
      const event = normalizePullRequestReviewEvent(args.deliveryId, args.body);
      return event ? [event] : [];
    }
    case "issue_comment": {
      const event = normalizeIssueCommentEvent(args.deliveryId, args.body);
      return event ? [event] : [];
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
    default:
      return [];
  }
}
