/**
 * GitHub check suite resource events.
 */
import type { ResourceEventInput } from "@sentry/junior-plugin-api";
import { z } from "zod";
import {
  githubRequest,
  isRecord,
  issueInstallationToken,
} from "../credential-support.js";
import { gitHubPullRequestResource } from "../resource-events/pull-request.js";
import { gitHubRepositoryResource } from "../resource-events/repository.js";

/** Match keys that need a pull request API load on check suite events. */
const CHECK_SUITE_PULL_REQUEST_MATCH_KEYS = new Set([
  "authorEmail",
  "authorUsername",
  "isDraft",
]);

function gitHubEventKey(deliveryId: string, eventType: string): string {
  return `github:${deliveryId}:${eventType}`;
}

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

/**
 * Check suite pull_requests use GitHub's CheckRunPullRequest shape:
 * url, id, number, head/base with repo { id, url, name }.
 * No draft, author, or full_name on those objects.
 * @see https://docs.github.com/en/webhooks/webhook-events-and-payloads#check_suite
 */
const checkRunRepoRefSchema = z
  .object({
    id: z.number(),
    name: z.string().min(1),
    url: z.string().min(1),
  })
  .passthrough();

const checkRunPullRequestSideSchema = z
  .object({
    ref: z.string().optional(),
    repo: checkRunRepoRefSchema,
    sha: z.string().optional(),
  })
  .passthrough();

const checkRunPullRequestSchema = z
  .object({
    base: checkRunPullRequestSideSchema,
    head: checkRunPullRequestSideSchema.optional(),
    id: z.number().optional(),
    number: z.number(),
    url: z.string().optional(),
  })
  .passthrough();

const repositorySchema = z
  .object({
    full_name: z.string().min(1),
    id: z.number(),
    name: z.string().min(1),
    owner: z.object({ login: z.string().min(1) }).passthrough(),
  })
  .passthrough();

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
    /** Branch name for the suite head commit when GitHub sends it. */
    head_branch: z.string().optional().nullable(),
    head_sha: z.string().optional(),
    id: z.number().optional(),
    latest_check_runs_count: z.number().optional().nullable(),
    pull_requests: z.array(checkRunPullRequestSchema),
  }),
  repository: repositorySchema,
});

/** List check runs in a suite: { check_runs: CheckRun[] }. */
const checkRunsListResponseSchema = z
  .object({
    check_runs: z.array(z.unknown()).optional(),
  })
  .passthrough();

/**
 * Keep only pull requests whose base repo is the check suite repository.
 * GitHub attaches every open PR with the same head sha, including PRs based on forks.
 * Compare repository ids from the webhook payload — no URL parsing.
 */
function isCheckSuiteRepositoryPullRequest(
  pullRequest: z.infer<typeof checkRunPullRequestSchema>,
  repositoryId: number,
): boolean {
  return pullRequest.base.repo.id === repositoryId;
}

/** Map a completed check suite conclusion to the resource event type we publish. */
function checkSuiteEventType(
  conclusion: string | null | undefined,
): "pull_request.checks.failed" | "pull_request.checks.recovered" | undefined {
  if (conclusion === "failure" || conclusion === "timed_out") {
    return "pull_request.checks.failed";
  }
  if (conclusion === "success") {
    return "pull_request.checks.recovered";
  }
  return undefined;
}

/** True when a GitHub API call failed with HTTP 404. */
function isGitHubNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "GitHubRequestError" &&
    "status" in error &&
    (error as { status: unknown }).status === 404
  );
}

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

/** Pull request values filled in when a match filter needs them. */
export type GitHubCheckSuitePullRequestFacts = {
  authorEmail?: string;
  authorUsername?: string;
  isDraft?: boolean;
};

/** Optional values for one check suite event. */
export type GitHubCheckSuiteFacts = {
  failingChecks?: GitHubFailingCheck[];
  /** Pull request values by number when a match filter needs them. */
  pullRequestFactsByNumber?: Record<number, GitHubCheckSuitePullRequestFacts>;
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

/** Read a non-empty branch name from a webhook string. */
function checkSuiteHeadBranch(
  value: string | null | undefined,
): string | undefined {
  const branch = value?.trim();
  return branch ? branch : undefined;
}

/** Build the trusted data and summary for one check-suite event. */
export function buildCheckSuiteResourceEvent(args: {
  appName?: string;
  authorEmail?: string;
  authorUsername?: string;
  checkSuiteId?: number;
  deliveryId: string;
  eventType: "pull_request.checks.failed" | "pull_request.checks.recovered";
  failingChecks?: GitHubFailingCheck[];
  headBranch?: string;
  headSha?: string;
  isDraft?: boolean;
  latestCheckRunsCount?: number;
  /** Same-repo pull request number when GitHub attached one. */
  pullRequestNumber?: number;
  repo: string;
  suiteConclusion: string;
}): ResourceEventInput {
  const pullRequestNumber = args.pullRequestNumber;
  const resource =
    pullRequestNumber === undefined
      ? gitHubRepositoryResource({ repo: args.repo })
      : gitHubPullRequestResource({
          number: pullRequestNumber,
          repo: args.repo,
        });
  const shortSha = args.headSha?.slice(0, 12);
  const failingChecks = (args.failingChecks ?? []).slice(0, 12);
  const failingCount = failingChecks.length;
  const branchSuffix = args.headBranch ? ` on ${args.headBranch}` : "";
  const trustedSummary =
    args.eventType === "pull_request.checks.failed"
      ? `${resource.label} checks failed${failingCount > 0 ? ` (${failingCount})` : ""}${shortSha ? ` for ${shortSha}` : ""}${branchSuffix}.`
      : `${resource.label} check suite recovered${shortSha ? ` for ${shortSha}` : ""}${branchSuffix}.`;

  const data: Record<string, unknown> = {
    repo: args.repo,
    scope: "check_suite",
    suiteConclusion: args.suiteConclusion,
  };
  if (pullRequestNumber !== undefined) data.pullRequest = pullRequestNumber;
  if (typeof args.isDraft === "boolean") data.isDraft = args.isDraft;
  if (args.authorUsername) data.authorUsername = args.authorUsername;
  if (args.authorEmail) data.authorEmail = args.authorEmail;
  if (args.headBranch) data.headBranch = args.headBranch;
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
      pullRequestNumber === undefined
        ? args.eventType
        : `${args.eventType}:${pullRequestNumber}`,
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
export function normalizeCheckSuiteEvents(
  deliveryId: string,
  body: unknown,
  options?: GitHubCheckSuiteFacts,
): ResourceEventInput[] {
  const parsed = checkSuiteWebhookSchema.safeParse(body);
  if (!parsed.success || parsed.data.action !== "completed") return [];
  const conclusion = parsed.data.check_suite.conclusion;
  const eventType = checkSuiteEventType(conclusion);
  if (!eventType || typeof conclusion !== "string") return [];
  const suite = parsed.data.check_suite;
  const appName = suite.app?.name?.trim() || suite.app?.slug?.trim() || undefined;
  const headBranch = checkSuiteHeadBranch(suite.head_branch);
  const headSha =
    typeof suite.head_sha === "string" && /^[0-9a-f]{7,40}$/i.test(suite.head_sha)
      ? suite.head_sha
      : undefined;
  const repository = parsed.data.repository;
  const repo = repository.full_name;
  const shared = {
    appName,
    checkSuiteId: suite.id,
    deliveryId,
    eventType,
    failingChecks:
      eventType === "pull_request.checks.failed"
        ? options?.failingChecks
        : undefined,
    headSha,
    latestCheckRunsCount:
      typeof suite.latest_check_runs_count === "number"
        ? suite.latest_check_runs_count
        : undefined,
    repo,
    suiteConclusion: conclusion,
  } as const;
  const sameRepoPullRequests = suite.pull_requests.filter((pullRequest) =>
    isCheckSuiteRepositoryPullRequest(pullRequest, repository.id),
  );
  // Bare branch suites (typical for main) have no same-repo PRs. Publish one
  // repository event so watches can match headBranch without a PR target.
  if (sameRepoPullRequests.length === 0) {
    return [
      buildCheckSuiteResourceEvent({
        ...shared,
        ...(headBranch ? { headBranch } : undefined),
      }),
    ];
  }
  return sameRepoPullRequests.flatMap((pullRequest) => {
    const facts = options?.pullRequestFactsByNumber?.[pullRequest.number];
    const pullRequestHeadBranch =
      checkSuiteHeadBranch(pullRequest.head?.ref) ?? headBranch;
    return pullRequestTargets(
      buildCheckSuiteResourceEvent({
        ...shared,
        ...(facts?.authorEmail ? { authorEmail: facts.authorEmail } : undefined),
        ...(facts?.authorUsername
          ? { authorUsername: facts.authorUsername }
          : undefined),
        ...(pullRequestHeadBranch
          ? { headBranch: pullRequestHeadBranch }
          : undefined),
        ...(typeof facts?.isDraft === "boolean"
          ? { isDraft: facts.isDraft }
          : undefined),
        pullRequestNumber: pullRequest.number,
      }),
      repo,
    );
  });
}

/** Identifiers and event types one completed check suite may publish. */
export function parseCheckSuitePublishTargets(body: unknown):
  | {
      eventTypes: string[];
      identifiers: string[];
    }
  | undefined {
  const parsed = checkSuiteWebhookSchema.safeParse(body);
  if (!parsed.success || parsed.data.action !== "completed") return undefined;
  const eventType = checkSuiteEventType(parsed.data.check_suite.conclusion);
  if (!eventType) return undefined;
  const repository = parsed.data.repository;
  const repo = repository.full_name;
  const identifiers = new Set<string>([
    gitHubRepositoryResource({ repo }).identifier,
  ]);
  for (const pullRequest of parsed.data.check_suite.pull_requests) {
    if (!isCheckSuiteRepositoryPullRequest(pullRequest, repository.id)) continue;
    identifiers.add(
      gitHubPullRequestResource({ number: pullRequest.number, repo }).identifier,
    );
  }
  return {
    eventTypes: [eventType],
    identifiers: [...identifiers],
  };
}

/** Read which check suite values still need a GitHub API load. */
export function parseCheckSuiteFactsTarget(
  body: unknown,
  options?: { loadPullRequestFacts?: boolean },
): {
  checkSuiteId: number;
  headSha: string;
  loadFailingChecks: boolean;
  loadPullRequestFacts: boolean;
  owner: string;
  pullRequestNumbers: number[];
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
  const repository = parsed.data.repository;
  const pullRequestNumbers = [
    ...new Set(
      parsed.data.check_suite.pull_requests
        .filter((pullRequest) =>
          isCheckSuiteRepositoryPullRequest(pullRequest, repository.id),
        )
        .map((pullRequest) => pullRequest.number),
    ),
  ];
  const loadFailingChecks =
    conclusion === "failure" || conclusion === "timed_out";
  const loadPullRequestFacts = Boolean(
    options?.loadPullRequestFacts && pullRequestNumbers.length > 0,
  );
  if (!loadFailingChecks && !loadPullRequestFacts) {
    return undefined;
  }
  return {
    checkSuiteId,
    headSha,
    loadFailingChecks,
    loadPullRequestFacts,
    owner: repository.owner.login,
    pullRequestNumbers,
    repoName: repository.name,
  };
}

function checkRunsFromResponse(value: unknown): unknown[] {
  const parsed = checkRunsListResponseSchema.safeParse(value);
  if (!parsed.success) return [];
  return parsed.data.check_runs ?? [];
}

function pullRequestFactsFromResponse(
  value: unknown,
): GitHubCheckSuitePullRequestFacts | undefined {
  if (!isRecord(value)) return undefined;
  const facts: GitHubCheckSuitePullRequestFacts = {};
  if (typeof value.draft === "boolean") facts.isDraft = value.draft;
  const user = value.user;
  if (isRecord(user)) {
    const username =
      typeof user.login === "string" ? user.login.trim() : undefined;
    if (username) facts.authorUsername = username;
    const email =
      typeof user.email === "string" ? user.email.trim() : undefined;
    if (email) facts.authorEmail = email;
  }
  return Object.keys(facts).length > 0 ? facts : undefined;
}

/** True when active match filters need pull request fields from the API. */
export function needsCheckSuitePullRequestFacts(
  matchKeys: Iterable<string>,
): boolean {
  for (const key of matchKeys) {
    if (CHECK_SUITE_PULL_REQUEST_MATCH_KEYS.has(key)) return true;
  }
  return false;
}

/** Load failed check runs and optional pull request match fields. */
export async function loadCheckSuiteFacts(args: {
  appIdEnv: string;
  body: unknown;
  installationIdEnv: string;
  loadPullRequestFacts?: boolean;
  log?: { error(message: string, metadata?: Record<string, unknown>): void };
  privateKeyEnv: string;
}): Promise<GitHubCheckSuiteFacts | undefined> {
  const target = parseCheckSuiteFactsTarget(args.body, {
    loadPullRequestFacts: args.loadPullRequestFacts,
  });
  if (!target) return undefined;

  const facts: GitHubCheckSuiteFacts = {};

  if (target.loadFailingChecks) {
    try {
      const token = await issueInstallationToken({
        appIdEnv: args.appIdEnv,
        installationIdEnv: args.installationIdEnv,
        permissions: { checks: "read" },
        privateKeyEnv: args.privateKeyEnv,
        repositories: [target.repoName],
      });
      // Load runs for this suite only. Commit-wide latest runs mix other apps.
      const response = await githubRequest(
        "https://api.github.com",
        `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repoName)}/check-suites/${target.checkSuiteId}/check-runs?filter=latest&per_page=100`,
        { token: token.token },
      );
      const failing = selectFailingChecks(checkRunsFromResponse(response), {
        checkSuiteId: target.checkSuiteId,
      });
      if (failing.length > 0) facts.failingChecks = failing;
    } catch (error) {
      args.log?.error("GitHub check suite load failed", {
        checkSuiteId: target.checkSuiteId,
        errorType: error instanceof Error ? error.name : "UnknownError",
        repository: `${target.owner}/${target.repoName}`,
      });
    }
  }

  if (target.loadPullRequestFacts) {
    try {
      const token = await issueInstallationToken({
        appIdEnv: args.appIdEnv,
        installationIdEnv: args.installationIdEnv,
        permissions: { pull_requests: "read" },
        privateKeyEnv: args.privateKeyEnv,
        repositories: [target.repoName],
      });
      const loaded = await Promise.all(
        target.pullRequestNumbers.map(async (number) => {
          try {
            const response = await githubRequest(
              "https://api.github.com",
              `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repoName)}/pulls/${number}`,
              { token: token.token },
            );
            const loadedFacts = pullRequestFactsFromResponse(response);
            return loadedFacts ? ([number, loadedFacts] as const) : undefined;
          } catch (error) {
            // 404 is expected when the suite lists a stale PR number.
            if (!isGitHubNotFoundError(error)) {
              args.log?.error("GitHub pull request data load failed", {
                errorType: error instanceof Error ? error.name : "UnknownError",
                pullRequest: number,
                repository: `${target.owner}/${target.repoName}`,
              });
            }
            return undefined;
          }
        }),
      );
      const pullRequestFactsByNumber: Record<
        number,
        GitHubCheckSuitePullRequestFacts
      > = {};
      for (const entry of loaded) {
        if (!entry) continue;
        pullRequestFactsByNumber[entry[0]] = entry[1];
      }
      if (Object.keys(pullRequestFactsByNumber).length > 0) {
        facts.pullRequestFactsByNumber = pullRequestFactsByNumber;
      }
    } catch (error) {
      args.log?.error("GitHub check suite pull request data load failed", {
        checkSuiteId: target.checkSuiteId,
        errorType: error instanceof Error ? error.name : "UnknownError",
        repository: `${target.owner}/${target.repoName}`,
      });
    }
  }

  return facts.failingChecks || facts.pullRequestFactsByNumber
    ? facts
    : undefined;
}
