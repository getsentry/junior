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

const repositorySchema = z
  .object({ full_name: z.string().min(1) })
  .passthrough();

const checkSuitePullRequestSchema = z
  .object({
    base: z
      .object({
        repo: z
          .object({
            full_name: z.string().optional(),
            url: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    draft: z.boolean().optional(),
    number: z.number(),
    url: z.string().optional(),
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
    head_sha: z.string().optional(),
    id: z.number().optional(),
    latest_check_runs_count: z.number().optional().nullable(),
    pull_requests: z.array(checkSuitePullRequestSchema),
  }),
  repository: repositorySchema,
});

/** Read owner/name from a GitHub REST repo or pull URL. */
function repositoryFullNameFromApiUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const match =
    /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)(?:\/|$)/i.exec(url);
  return match?.[1];
}

/** Base repository for one check-suite pull_requests entry, when GitHub sends it. */
function checkSuitePullRequestBaseRepo(pullRequest: {
  base?: { repo?: { full_name?: string; url?: string } };
  url?: string;
}): string | undefined {
  const fullName = pullRequest.base?.repo?.full_name?.trim();
  if (fullName) return fullName;
  return (
    repositoryFullNameFromApiUrl(pullRequest.base?.repo?.url) ??
    repositoryFullNameFromApiUrl(pullRequest.url)
  );
}

/**
 * Keep only PRs whose base repo is the check-suite repository.
 * GitHub attaches every open PR whose head sha matches, including PRs against forks.
 * When base identity is missing, keep the PR (common same-repo payloads and tests).
 */
function isCheckSuiteRepositoryPullRequest(
  pullRequest: {
    base?: { repo?: { full_name?: string; url?: string } };
    url?: string;
  },
  repositoryFullName: string,
): boolean {
  const baseRepo = checkSuitePullRequestBaseRepo(pullRequest);
  if (!baseRepo) return true;
  return baseRepo.toLowerCase() === repositoryFullName.toLowerCase();
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

/** Pull request values filled in when the check suite body omits them. */
export type GitHubCheckSuitePullRequestFacts = {
  authorEmail?: string;
  authorUsername?: string;
  isDraft?: boolean;
};

/** Optional values for one check suite event. */
export type GitHubCheckSuiteFacts = {
  failingChecks?: GitHubFailingCheck[];
  /** Pull request values by number when GitHub omitted them on the suite. */
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

/** Build the trusted data and summary for one check-suite PR event. */
export function buildCheckSuiteResourceEvent(args: {
  appName?: string;
  authorEmail?: string;
  authorUsername?: string;
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
  if (args.authorUsername) data.authorUsername = args.authorUsername;
  if (args.authorEmail) data.authorEmail = args.authorEmail;
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
export function normalizeCheckSuiteEvents(
  deliveryId: string,
  body: unknown,
  options?: GitHubCheckSuiteFacts,
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
  const repo = parsed.data.repository.full_name;
  return suite.pull_requests.flatMap((pullRequest) => {
    if (!isCheckSuiteRepositoryPullRequest(pullRequest, repo)) return [];
    const facts = options?.pullRequestFactsByNumber?.[pullRequest.number];
    const draft =
      typeof pullRequest.draft === "boolean"
        ? pullRequest.draft
        : typeof facts?.isDraft === "boolean"
          ? facts.isDraft
          : undefined;
    return pullRequestTargets(
      buildCheckSuiteResourceEvent({
        appName,
        ...(facts?.authorEmail ? { authorEmail: facts.authorEmail } : undefined),
        ...(facts?.authorUsername
          ? { authorUsername: facts.authorUsername }
          : undefined),
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


/** Read which check suite values still need a GitHub API load. */
export function parseCheckSuiteFactsTarget(body: unknown): {
  checkSuiteId: number;
  headSha: string;
  loadFailingChecks: boolean;
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
  const repositoryFullName = parsed.data.repository.full_name;
  const [owner, repoName, ...extra] = repositoryFullName.split("/");
  if (!owner || !repoName || extra.length > 0) return undefined;
  // Only load PRs based on this repository. Foreign fork PRs share head sha and 404 here.
  const pullRequestNumbers = [
    ...new Set(
      parsed.data.check_suite.pull_requests
        .filter((pullRequest) =>
          isCheckSuiteRepositoryPullRequest(pullRequest, repositoryFullName),
        )
        .map((pullRequest) => pullRequest.number),
    ),
  ];
  const loadFailingChecks =
    conclusion === "failure" || conclusion === "timed_out";
  // Check suite PR objects omit author; load PR values whenever a PR is attached.
  if (
    !loadFailingChecks &&
    pullRequestNumbers.length === 0
  ) {
    return undefined;
  }
  return {
    checkSuiteId,
    headSha,
    loadFailingChecks,
    owner,
    pullRequestNumbers,
    repoName,
  };
}

function checkRunsFromResponse(value: unknown): unknown[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const checkRuns = (value as { check_runs?: unknown }).check_runs;
  return Array.isArray(checkRuns) ? checkRuns : [];
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

/** Load missing values for one check suite event. */
export async function loadCheckSuiteFacts(args: {
  appIdEnv: string;
  body: unknown;
  installationIdEnv: string;
  log?: { error(message: string, metadata?: Record<string, unknown>): void };
  privateKeyEnv: string;
}): Promise<GitHubCheckSuiteFacts | undefined> {
  const target = parseCheckSuiteFactsTarget(args.body);
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

  if (target.pullRequestNumbers.length > 0) {
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
            const facts = pullRequestFactsFromResponse(response);
            return facts ? ([number, facts] as const) : undefined;
          } catch (error) {
            // 404 is expected when the suite lists a stale or foreign PR number.
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
