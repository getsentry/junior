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

/** Include isDraft only when GitHub sent an explicit draft boolean. */
function pullRequestDraftData(
  draft: boolean | undefined,
): { isDraft: boolean } | undefined {
  return typeof draft === "boolean" ? { isDraft: draft } : undefined;
}

/** Address a pull request event through both the pull request and its repository. */
function pullRequestTargets(
  event: ResourceEventInput,
  repo: string,
): ResourceEventInput[] {
  const { terminal: _terminal, ...repositoryEvent } = event;
  return [
    event,
    {
      ...repositoryEvent,
      identifier: gitHubRepositoryResource({ repo }).identifier,
    },
  ];
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
      ...(terminal && completeOnTerminalEvent ? { terminal: true } : undefined),
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
    app: z
      .object({
        name: z.string().optional().nullable(),
        slug: z.string().optional().nullable(),
      })
      .optional()
      .nullable(),
    conclusion: z.string().optional().nullable(),
    head_sha: z.string().optional(),
    id: z.number().optional(),
    latest_check_runs_count: z.number().optional().nullable(),
    pull_requests: z.array(
      z.object({ draft: z.boolean().optional(), number: z.number() }),
    ),
  }),
  repository: repositorySchema,
});

const FAILING_CHECK_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
]);

export type GitHubFailingCheck = {
  checkRunId: number;
  conclusion: string;
  htmlUrl?: string;
  name: string;
};

/** Extra check-suite facts loaded when the webhook body omits them. */
export type GitHubCheckSuiteEnrichment = {
  failingChecks?: GitHubFailingCheck[];
  /** Draft state by pull request number when GitHub omitted draft on the suite. */
  pullRequestDraftByNumber?: Record<number, boolean>;
};

/** Build a browser URL for one check suite. GitHub does not send html_url. */
export function buildCheckSuiteUrl(args: {
  checkSuiteId: number;
  headSha: string;
  repo: string;
}): string {
  return `https://github.com/${args.repo}/commit/${args.headSha}/checks?check_suite_id=${args.checkSuiteId}`;
}

/** Collapse provider free text into one short summary fragment. */
function oneLineLabel(value: string, maxLength = 80): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

/** Build the trusted data and summary for one check-suite PR event. */
export function buildCheckSuiteResourceEvent(args: {
  appName?: string;
  checkSuiteId?: number;
  deliveryId: string;
  eventType: "pull_request.checks.failed" | "pull_request.checks.recovered";
  failingChecks?: GitHubFailingCheck[];
  headSha?: string;
  isDraft?: boolean;
  latestCheckRunsCount?: number;
  pullRequestNumber: number;
  repo: string;
  suiteConclusion: string;
}): ResourceEventInput {
  const resource = gitHubPullRequestResource({
    number: args.pullRequestNumber,
    repo: args.repo,
  });
  const shortSha = args.headSha?.slice(0, 12);
  const failingChecks = (args.failingChecks ?? []).slice(0, 12);
  const failingCount = failingChecks.length;
  const trustedSummary =
    args.eventType === "pull_request.checks.failed"
      ? `${resource.label} checks failed${failingCount > 0 ? ` (${failingCount})` : ""}${shortSha ? ` for ${shortSha}` : ""}.`
      : `${resource.label} check suite recovered${shortSha ? ` for ${shortSha}` : ""}.`;

  const data: Record<string, unknown> = {
    repo: args.repo,
    pullRequest: args.pullRequestNumber,
    scope: "check_suite",
    suiteConclusion: args.suiteConclusion,
  };
  if (typeof args.isDraft === "boolean") data.isDraft = args.isDraft;
  if (args.headSha) data.headSha = args.headSha;
  if (args.checkSuiteId !== undefined) data.checkSuiteId = args.checkSuiteId;
  if (args.checkSuiteId !== undefined && args.headSha) {
    data.checkSuiteUrl = buildCheckSuiteUrl({
      checkSuiteId: args.checkSuiteId,
      headSha: args.headSha,
      repo: args.repo,
    });
  }
  if (args.appName) data.appName = oneLineLabel(args.appName, 120);
  if (args.latestCheckRunsCount !== undefined) {
    data.latestCheckRunsCount = args.latestCheckRunsCount;
  }
  // Keep only system-controlled handles in trusted data. Check names come from
  // workflow YAML and belong in untrustedText.
  if (args.eventType === "pull_request.checks.failed" && failingCount > 0) {
    data.failingChecks = failingChecks.map((check) => ({
      conclusion: check.conclusion,
      ...(check.htmlUrl ? { htmlUrl: check.htmlUrl } : undefined),
      checkRunId: check.checkRunId,
    }));
  }

  const untrustedParts =
    args.eventType === "pull_request.checks.failed"
      ? failingChecks
          .map((check) => {
            const name = oneLineLabel(check.name);
            if (!name) return undefined;
            return check.htmlUrl ? `${name}: ${check.htmlUrl}` : name;
          })
          .filter((part): part is string => part !== undefined)
      : [];
  const untrustedText =
    untrustedParts.length > 0
      ? [`Failed checks:`, ...untrustedParts.map((part) => `- ${part}`)].join(
          "\n",
        )
      : undefined;

  return {
    eventKey: gitHubEventKey(
      args.deliveryId,
      `${args.eventType}:${args.pullRequestNumber}`,
    ),
    eventType: args.eventType,
    occurredAtMs: Date.now(),
    identifier: resource.identifier,
    trustedSummary,
    data,
    ...(untrustedText ? { untrustedText } : undefined),
  };
}

/** Keep only failed check runs from one suite. */
export function selectFailingChecks(
  checkRuns: unknown,
  options?: { checkSuiteId?: number },
): GitHubFailingCheck[] {
  if (!Array.isArray(checkRuns)) return [];
  const failing: GitHubFailingCheck[] = [];
  for (const run of checkRuns) {
    if (!run || typeof run !== "object" || Array.isArray(run)) continue;
    const record = run as Record<string, unknown>;
    // Drop runs that name a different suite. Keep runs with no suite id when
    // the caller already loaded by suite endpoint.
    if (options?.checkSuiteId !== undefined) {
      const suite = record.check_suite;
      const suiteId =
        suite &&
        typeof suite === "object" &&
        !Array.isArray(suite) &&
        typeof (suite as { id?: unknown }).id === "number"
          ? (suite as { id: number }).id
          : undefined;
      if (suiteId !== undefined && suiteId !== options.checkSuiteId) continue;
    }
    const conclusion =
      typeof record.conclusion === "string" ? record.conclusion : undefined;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const checkRunId =
      typeof record.id === "number" && Number.isSafeInteger(record.id)
        ? record.id
        : undefined;
    if (!conclusion || !FAILING_CHECK_CONCLUSIONS.has(conclusion)) continue;
    if (!name || checkRunId === undefined) continue;
    const htmlUrl =
      typeof record.html_url === "string" && record.html_url.length > 0
        ? record.html_url
        : undefined;
    failing.push({
      checkRunId,
      conclusion,
      ...(htmlUrl ? { htmlUrl } : undefined),
      name,
    });
  }
  return failing.slice(0, 12);
}

/** Normalize a completed check suite for each attached pull request. */
function normalizeCheckSuiteEvents(
  deliveryId: string,
  body: unknown,
  options?: GitHubCheckSuiteEnrichment,
): ResourceEventInput[] {
  const parsed = checkSuiteWebhookSchema.safeParse(body);
  if (!parsed.success || parsed.data.action !== "completed") return [];
  const conclusion = parsed.data.check_suite.conclusion;
  if (!conclusion) return [];
  const eventType =
    conclusion === "failure" || conclusion === "timed_out"
      ? "pull_request.checks.failed"
      : conclusion === "success"
        ? "pull_request.checks.recovered"
        : undefined;
  if (!eventType) return [];
  const suite = parsed.data.check_suite;
  const appName = suite.app?.name?.trim() || suite.app?.slug?.trim() || undefined;
  const headSha =
    typeof suite.head_sha === "string" && /^[0-9a-f]{7,40}$/i.test(suite.head_sha)
      ? suite.head_sha
      : undefined;
  return suite.pull_requests.flatMap((pullRequest) => {
    const repo = parsed.data.repository.full_name;
    const enrichedDraft = options?.pullRequestDraftByNumber?.[pullRequest.number];
    const draft =
      typeof pullRequest.draft === "boolean"
        ? pullRequest.draft
        : typeof enrichedDraft === "boolean"
          ? enrichedDraft
          : undefined;
    return pullRequestTargets(
      buildCheckSuiteResourceEvent({
        appName,
        checkSuiteId: suite.id,
        deliveryId,
        eventType,
        failingChecks:
          eventType === "pull_request.checks.failed"
            ? options?.failingChecks
            : undefined,
        headSha,
        ...(typeof draft === "boolean" ? { isDraft: draft } : undefined),
        latestCheckRunsCount:
          typeof suite.latest_check_runs_count === "number"
            ? suite.latest_check_runs_count
            : undefined,
        pullRequestNumber: pullRequest.number,
        repo,
        suiteConclusion: conclusion,
      }),
      repo,
    );
  });
}

const issueCommentWebhookSchema = z.object({
  action: z.string(),
  comment: z.object({
    body: z.string(),
    user: z.object({ login: z.string().optional() }).optional(),
  }),
  issue: z.object({
    draft: z.boolean().optional(),
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
    const draftData = pullRequestDraftData(parsed.data.issue.draft);
    return pullRequestTargets(
      {
        eventKey: gitHubEventKey(deliveryId, eventType),
        eventType,
        occurredAtMs: Date.now(),
        identifier: resource.identifier,
        trustedSummary: `${resource.label} received a comment${author ? ` from ${author}` : ""}.`,
        ...(draftData ? { data: draftData } : undefined),
        untrustedText: parsed.data.comment.body,
      },
      input.repo,
    );
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
      ...(untrustedText ? { untrustedText } : undefined),
    },
    {
      eventKey: gitHubEventKey(deliveryId, `issue.${state}`),
      eventType: `issue.${state}`,
      occurredAtMs,
      identifier: repository.identifier,
      trustedSummary: `${issue.label} was ${state}.`,
      ...(untrustedText ? { untrustedText } : undefined),
    },
  ];
}

const pullRequestReviewCommentWebhookSchema = z.object({
  action: z.string(),
  comment: z.object({
    body: z.string(),
    user: z.object({ login: z.string().optional() }).optional(),
  }),
  pull_request: z.object({ draft: z.boolean().optional(), number: z.number() }),
  repository: repositorySchema,
});

/** Normalize a newly created inline pull request review comment. */
function normalizePullRequestReviewCommentEvent(
  deliveryId: string,
  body: unknown,
): ResourceEventInput[] {
  const parsed = pullRequestReviewCommentWebhookSchema.safeParse(body);
  if (!parsed.success || parsed.data.action !== "created") return [];
  const eventType = "pull_request.review_comment.created";
  const repo = parsed.data.repository.full_name;
  const resource = gitHubPullRequestResource({
    number: parsed.data.pull_request.number,
    repo,
  });
  const author = parsed.data.comment.user?.login;
  const draftData = pullRequestDraftData(parsed.data.pull_request.draft);
  return pullRequestTargets(
    {
      eventKey: gitHubEventKey(deliveryId, eventType),
      eventType,
      occurredAtMs: Date.now(),
      identifier: resource.identifier,
      trustedSummary: `${resource.label} received an inline review comment${author ? ` from ${author}` : ""}.`,
      ...(draftData ? { data: draftData } : undefined),
      untrustedText: parsed.data.comment.body,
    },
    repo,
  );
}

const pullRequestReviewWebhookSchema = z.object({
  action: z.string(),
  pull_request: z.object({ draft: z.boolean().optional(), number: z.number() }),
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
): ResourceEventInput[] {
  const parsed = pullRequestReviewWebhookSchema.safeParse(body);
  if (!parsed.success || parsed.data.action !== "submitted") return [];
  const reviewState = parsed.data.review.state.toUpperCase();
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
    number: parsed.data.pull_request.number,
    repo,
  });
  const reviewer = parsed.data.review.user?.login;
  const draftData = pullRequestDraftData(parsed.data.pull_request.draft);
  return pullRequestTargets(
    {
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
      ...(draftData ? { data: draftData } : undefined),
      untrustedText: parsed.data.review.body ?? undefined,
    },
    repo,
  );
}

const pullRequestWebhookSchema = z.object({
  action: z.string(),
  pull_request: z.object({
    body: z.string().optional().nullable(),
    closed_at: z.string().optional().nullable(),
    created_at: z.string().optional(),
    draft: z.boolean().optional(),
    merged: z.boolean().optional(),
    merged_at: z.string().optional().nullable(),
    number: z.number(),
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

function pullRequestEventText(pullRequest: {
  body?: string | null;
  title?: string;
}): string | undefined {
  const parts = [
    pullRequest.title ? `Title: ${pullRequest.title}` : undefined,
    pullRequest.body?.trim() || undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** Build the PR and repository targets for one pull request lifecycle event. */
function pullRequestLifecycleEvents(input: {
  deliveryId: string;
  eventType: string;
  isDraft?: boolean;
  occurredAtMs: number;
  repo: string;
  resource: ReturnType<typeof gitHubPullRequestResource>;
  terminal?: true;
  trustedSummary: string;
  untrustedText?: string;
}): ResourceEventInput[] {
  const draftData = pullRequestDraftData(input.isDraft);
  return pullRequestTargets(
    {
      eventKey: gitHubEventKey(input.deliveryId, input.eventType),
      eventType: input.eventType,
      occurredAtMs: input.occurredAtMs,
      identifier: input.resource.identifier,
      ...(input.terminal ? { terminal: true } : undefined),
      trustedSummary: input.trustedSummary,
      ...(draftData ? { data: draftData } : undefined),
      ...(input.untrustedText ? { untrustedText: input.untrustedText } : undefined),
    },
    input.repo,
  );
}

/** Normalize pull request opened, ready-for-review, and terminal lifecycle events. */
function normalizePullRequestEvent(
  deliveryId: string,
  body: unknown,
): ResourceEventInput[] {
  const parsed = pullRequestWebhookSchema.safeParse(body);
  if (!parsed.success) return [];

  const repo = parsed.data.repository.full_name;
  const resource = gitHubPullRequestResource({
    number: parsed.data.pull_request.number,
    repo,
  });
  const draft = parsed.data.pull_request.draft;
  const isDraft = typeof draft === "boolean" ? draft : undefined;
  const untrustedText = pullRequestEventText(parsed.data.pull_request);

  if (parsed.data.action === "opened") {
    const openedAtMs =
      providerTime(parsed.data.pull_request.created_at) ?? Date.now();
    const events = pullRequestLifecycleEvents({
      deliveryId,
      eventType: "pull_request.opened",
      ...(isDraft !== undefined ? { isDraft } : undefined),
      occurredAtMs: openedAtMs,
      repo,
      resource,
      trustedSummary: `${resource.label} was opened.`,
      untrustedText,
    });
    // Non-draft opens are immediately reviewable; emit the same signal used
    // when a draft later leaves draft state.
    if (draft !== true) {
      events.push(
        ...pullRequestLifecycleEvents({
          deliveryId,
          eventType: "pull_request.ready_for_review",
          isDraft: false,
          occurredAtMs: openedAtMs,
          repo,
          resource,
          trustedSummary: `${resource.label} is ready for review.`,
          untrustedText,
        }),
      );
    }
    return events;
  }

  if (parsed.data.action === "ready_for_review") {
    return pullRequestLifecycleEvents({
      deliveryId,
      eventType: "pull_request.ready_for_review",
      isDraft: false,
      occurredAtMs:
        providerTime(parsed.data.pull_request.updated_at) ?? Date.now(),
      repo,
      resource,
      trustedSummary: `${resource.label} is ready for review.`,
      untrustedText,
    });
  }

  if (parsed.data.action !== "closed") return [];
  const eventType = parsed.data.pull_request.merged
    ? "pull_request.merged"
    : "pull_request.closed_unmerged";
  return pullRequestLifecycleEvents({
    deliveryId,
    eventType,
    ...(isDraft !== undefined ? { isDraft } : undefined),
    occurredAtMs:
      providerTime(
        parsed.data.pull_request.merged
          ? parsed.data.pull_request.merged_at
          : parsed.data.pull_request.closed_at,
      ) ?? Date.now(),
    repo,
    resource,
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
      ...(completeOnTerminalEvent ? { terminal: true } : undefined),
      trustedSummary: `${resource.label} was published (release ${parsed.data.release.id}).`,
      ...(untrustedText ? { untrustedText } : undefined),
    }),
  );
}

/** Read the check suite target used to load missing suite facts. */
export function parseCheckSuiteEnrichmentTarget(body: unknown): {
  checkSuiteId: number;
  headSha: string;
  loadFailingChecks: boolean;
  owner: string;
  pullRequestNumbersMissingDraft: number[];
  repoName: string;
} | undefined {
  const parsed = checkSuiteWebhookSchema.safeParse(body);
  if (!parsed.success || parsed.data.action !== "completed") return undefined;
  const conclusion = parsed.data.check_suite.conclusion;
  if (
    conclusion !== "failure" &&
    conclusion !== "timed_out" &&
    conclusion !== "success"
  ) {
    return undefined;
  }
  const headSha = parsed.data.check_suite.head_sha;
  const checkSuiteId = parsed.data.check_suite.id;
  if (
    typeof headSha !== "string" ||
    !/^[0-9a-f]{7,40}$/i.test(headSha) ||
    typeof checkSuiteId !== "number"
  ) {
    return undefined;
  }
  const [owner, repoName, ...extra] = parsed.data.repository.full_name.split("/");
  if (!owner || !repoName || extra.length > 0) return undefined;
  const pullRequestNumbersMissingDraft = [
    ...new Set(
      parsed.data.check_suite.pull_requests
        .filter((pullRequest) => typeof pullRequest.draft !== "boolean")
        .map((pullRequest) => pullRequest.number),
    ),
  ];
  const loadFailingChecks =
    conclusion === "failure" || conclusion === "timed_out";
  if (!loadFailingChecks && pullRequestNumbersMissingDraft.length === 0) {
    return undefined;
  }
  return {
    checkSuiteId,
    headSha,
    loadFailingChecks,
    owner,
    pullRequestNumbersMissingDraft,
    repoName,
  };
}

/** Normalize one verified GitHub delivery into conversation resource events. */
export function normalizeGitHubResourceEvents(args: {
  body: unknown;
  checkSuiteEnrichment?: GitHubCheckSuiteEnrichment;
  deliveryId: string;
  eventName: string;
}): ResourceEventInput[] {
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
      return normalizePullRequestReviewEvent(args.deliveryId, args.body);
    case "issue_comment":
      return normalizeIssueCommentEvents(args.deliveryId, args.body);
    case "pull_request_review_comment":
      return normalizePullRequestReviewCommentEvent(args.deliveryId, args.body);
    case "check_suite":
      return normalizeCheckSuiteEvents(
        args.deliveryId,
        args.body,
        args.checkSuiteEnrichment,
      );
    case "release":
      return normalizeReleaseEvent(args.deliveryId, args.body);
    default:
      return [];
  }
}
