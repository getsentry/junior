/**
 * GitHub check suite events.
 */
import type {
  EventInput,
  EventPublisher,
  PluginLogger,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import {
  githubRequest,
  isRecord,
  issueInstallationToken,
} from "../credential-support.js";
import type { GitHubStatusIncident } from "../github-status.js";
import { gitHubPullRequestResource } from "../events/pull-request.js";
import { gitHubRepositoryResource } from "../events/repository.js";
import {
  gitHubCommitShaDataSchema,
  gitHubRepoDataSchema,
} from "../events/scope.js";
import {
  definedValues,
  gitHubEventKey,
  pullRequestTargets,
} from "./event-targets.js";
import { logFailOpenFailure } from "./fail-open-log.js";

/** Match keys that need a pull request API load on check suite events. */
const CHECK_SUITE_PULL_REQUEST_MATCH_KEYS = new Set([
  "isDraft",
  "openerEmail",
  "openerRole",
  "openerUsername",
]);

/**
 * Match keys whose values load after the webhook decides whether to read the
 * check suites, so a match check then cannot rule out a filter on them.
 */
const LATE_MATCH_KEYS = new Set([
  ...CHECK_SUITE_PULL_REQUEST_MATCH_KEYS,
  "authors",
]);

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

/** List check suites for a commit: { total_count, check_suites: CheckSuite[] }. */
const checkSuitesListResponseSchema = z.object({
  check_suites: z.array(
    z.object({
      app: z
        .object({ slug: z.string().nullable().optional() })
        .nullable()
        .optional(),
      conclusion: z.string().nullable().optional(),
      id: z.number(),
      latest_check_runs_count: z.number().nullable().optional(),
      status: z.string().nullable().optional(),
    }),
  ),
  total_count: z.number(),
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

type CheckSuiteEventType =
  | "pull_request.checks.failed"
  | "pull_request.checks.passed"
  | "pull_request.checks.recovered";

const CHECKS_PASSED = "pull_request.checks.passed";

/** Suite conclusions that count as passing for `pull_request.checks.passed`. */
const PASSING_SUITE_CONCLUSIONS = new Set(["neutral", "skipped", "success"]);

/** Pages of 100 check suites to read for one commit before giving up. */
const MAX_CHECK_SUITE_PAGES = 10;

/** Map a completed check suite conclusion to the event type we publish. */
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

/**
 * Event types that a completed suite may publish. Any passing suite can be
 * the last one on its commit, so each one is a `pull_request.checks.passed`
 * candidate. The webhook keeps that event only when every suite passed.
 */
function checkSuiteEventTypes(
  conclusion: string | null | undefined,
): CheckSuiteEventType[] {
  const eventType = checkSuiteEventType(conclusion);
  const eventTypes: CheckSuiteEventType[] = eventType ? [eventType] : [];
  if (PASSING_SUITE_CONCLUSIONS.has(conclusion ?? "")) {
    eventTypes.push(CHECKS_PASSED);
  }
  return eventTypes;
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
  openerEmail?: string;
  openerUsername?: string;
  isDraft?: boolean;
};

/** Optional values for one check suite event. */
export type GitHubCheckSuiteFacts = {
  failingChecks?: GitHubFailingCheck[];
  /** Open or recent githubstatus.com incidents when the suite failed. */
  githubIncidents?: GitHubStatusIncident[];
  /**
   * True when this suite passed and every other check suite on its head
   * commit passed too. Set only when something listens for
   * `pull_request.checks.passed`.
   */
  allCheckSuitesPassed?: boolean;
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

/** Non-empty branch name from a webhook string. */
function checkSuiteHeadBranch(
  value: string | null | undefined,
): string | undefined {
  const branch = value?.trim();
  return branch ? branch : undefined;
}

/**
 * Trusted data on every check suite event. `pullRequest` is missing when
 * GitHub links the suite to no pull request, such as on the main branch.
 * `commitSha` is missing when GitHub sends no full SHA. `suiteConclusion`
 * stays as a detail, not a filter: the event type already tells failed from
 * recovered.
 */
const checkSuiteEventDataSchema = z
  .object({
    repo: gitHubRepoDataSchema,
    pullRequest: z.number().optional(),
    commitSha: gitHubCommitShaDataSchema.optional(),
    suiteConclusion: z.string().min(1),
    isDraft: z.boolean().optional(),
    openerUsername: z.string().min(1).optional(),
    openerEmail: z.string().min(1).optional(),
    headBranch: z.string().min(1).optional(),
    checkSuiteId: z.number().optional(),
    checkSuiteUrl: z.string().min(1).optional(),
    appName: z.string().min(1).optional(),
    latestCheckRunsCount: z.number().optional(),
    // Only system-set handles. Check names come from workflow YAML, so they
    // go in the untrusted text.
    failingChecks: z
      .array(
        z
          .object({
            conclusion: z.string(),
            htmlUrl: z.string().optional(),
            checkRunId: z.number(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

/** Build the trusted data and summary for one check-suite event. */
export function buildCheckSuiteEvent(args: {
  appName?: string;
  openerEmail?: string;
  openerUsername?: string;
  checkSuiteId?: number;
  deliveryId: string;
  eventType: CheckSuiteEventType;
  failingChecks?: GitHubFailingCheck[];
  githubIncidents?: GitHubStatusIncident[];
  headBranch?: string;
  headSha?: string;
  isDraft?: boolean;
  latestCheckRunsCount?: number;
  /** Pull request number when GitHub attached one. */
  pullRequestNumber?: number;
  repo: string;
  suiteConclusion: string;
}): EventInput {
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
  const incidents =
    args.eventType === "pull_request.checks.failed"
      ? (args.githubIncidents ?? [])
      : [];
  const incidentSuffix =
    incidents.length > 0
      ? ` githubstatus.com lists ${incidents.length} open or recent GitHub incident${incidents.length === 1 ? "" : "s"}.`
      : "";
  const shaSuffix = shortSha ? ` for ${shortSha}` : "";
  const trustedSummary =
    args.eventType === "pull_request.checks.failed"
      ? `${resource.label} checks failed${failingCount > 0 ? ` (${failingCount})` : ""}${shaSuffix}${branchSuffix}.${incidentSuffix}`
      : args.eventType === CHECKS_PASSED
        ? `${resource.label} all check suites passed${shaSuffix}${branchSuffix}.`
        : `${resource.label} check suite recovered${shaSuffix}${branchSuffix}.`;

  const data = checkSuiteEventDataSchema.parse(
    definedValues({
      repo: args.repo,
      pullRequest: pullRequestNumber,
      // A short SHA counts as missing, so a commitSha filter does not match.
      commitSha: gitHubCommitShaDataSchema.safeParse(args.headSha).data,
      suiteConclusion: args.suiteConclusion,
      isDraft: args.isDraft,
      openerUsername: args.openerUsername,
      openerEmail: args.openerEmail,
      headBranch: args.headBranch,
      checkSuiteId: args.checkSuiteId,
      checkSuiteUrl:
        args.checkSuiteId !== undefined && args.headSha
          ? buildCheckSuiteUrl({
              checkSuiteId: args.checkSuiteId,
              headSha: args.headSha,
              repo: args.repo,
            })
          : undefined,
      appName: args.appName ? oneLineLabel(args.appName, 120) : undefined,
      latestCheckRunsCount: args.latestCheckRunsCount,
      failingChecks:
        args.eventType === "pull_request.checks.failed" && failingCount > 0
          ? failingChecks.map((check) => ({
              conclusion: check.conclusion,
              ...(check.htmlUrl ? { htmlUrl: check.htmlUrl } : undefined),
              checkRunId: check.checkRunId,
            }))
          : undefined,
    }),
  );

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
  const untrustedSections = [
    ...(untrustedParts.length > 0
      ? [
          [`Failed checks:`, ...untrustedParts.map((part) => `- ${part}`)].join(
            "\n",
          ),
        ]
      : []),
    ...(incidents.length > 0
      ? [
          [
            "GitHub status incidents:",
            ...incidents.map(
              (incident) =>
                `- ${oneLineLabel(incident.name, 160)} (${incident.status}; ${incident.components.join(", ") || "no components"}; started ${incident.startedAt}${incident.resolvedAt ? `, resolved ${incident.resolvedAt}` : ""}): ${incident.url}`,
            ),
          ].join("\n"),
        ]
      : []),
  ];
  const untrustedText =
    untrustedSections.length > 0 ? untrustedSections.join("\n\n") : undefined;

  return {
    // Each suite that finishes last can see every suite green, so name the
    // head commit, not the delivery. Core then delivers checks.passed once
    // per head commit to each Watch and event automation.
    eventKey:
      args.eventType === CHECKS_PASSED && args.headSha
        ? `github:${CHECKS_PASSED}:${resource.identifier}:${args.headSha.toLowerCase()}`
        : gitHubEventKey(
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
      const suite = record["check_suite"];
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
      typeof record["conclusion"] === "string"
        ? record["conclusion"]
        : undefined;
    const name =
      typeof record["name"] === "string" ? record["name"].trim() : "";
    const checkRunId =
      typeof record["id"] === "number" && Number.isSafeInteger(record["id"])
        ? record["id"]
        : undefined;
    if (!conclusion || !FAILING_CHECK_CONCLUSIONS.has(conclusion)) continue;
    if (!name || checkRunId === undefined) continue;
    const htmlUrl =
      typeof record["html_url"] === "string" && record["html_url"].length > 0
        ? record["html_url"]
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

/** Normalize a completed check suite for attached PRs, or the repository alone. */
export function normalizeCheckSuiteEvents(
  deliveryId: string,
  body: unknown,
  options?: GitHubCheckSuiteFacts,
): EventInput[] {
  const parsed = checkSuiteWebhookSchema.safeParse(body);
  if (!parsed.success || parsed.data.action !== "completed") return [];
  const conclusion = parsed.data.check_suite.conclusion;
  const eventType = checkSuiteEventType(conclusion);
  const eventTypes = checkSuiteEventTypes(conclusion).filter(
    (type) => type !== CHECKS_PASSED || options?.allCheckSuitesPassed,
  );
  if (eventTypes.length === 0 || typeof conclusion !== "string") return [];
  const suite = parsed.data.check_suite;
  const appName =
    suite.app?.name?.trim() || suite.app?.slug?.trim() || undefined;
  const headBranch = checkSuiteHeadBranch(suite.head_branch);
  const headSha =
    typeof suite.head_sha === "string" &&
    /^[0-9a-f]{7,40}$/i.test(suite.head_sha)
      ? suite.head_sha
      : undefined;
  const repository = parsed.data.repository;
  const repo = repository.full_name;
  const shared = {
    appName,
    checkSuiteId: suite.id,
    deliveryId,
    failingChecks:
      eventType === "pull_request.checks.failed"
        ? options?.failingChecks
        : undefined,
    githubIncidents:
      eventType === "pull_request.checks.failed"
        ? options?.githubIncidents
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
  // No same-repo PR (common on main): one repository event with headBranch.
  if (sameRepoPullRequests.length === 0) {
    return eventTypes.map((type) =>
      buildCheckSuiteEvent({
        ...shared,
        eventType: type,
        ...(headBranch ? { headBranch } : undefined),
      }),
    );
  }
  return eventTypes.flatMap((type) =>
    sameRepoPullRequests.flatMap((pullRequest) => {
      const facts = options?.pullRequestFactsByNumber?.[pullRequest.number];
      const pullRequestHeadBranch =
        checkSuiteHeadBranch(pullRequest.head?.ref) ?? headBranch;
      return pullRequestTargets(
        buildCheckSuiteEvent({
          ...shared,
          eventType: type,
          ...(facts?.openerEmail
            ? { openerEmail: facts.openerEmail }
            : undefined),
          ...(facts?.openerUsername
            ? { openerUsername: facts.openerUsername }
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
    }),
  );
}

/** The same-repository pull requests of one completed check suite. */
export function checkSuitePullRequests(
  body: unknown,
): Array<{ number: number; repositoryFullName: string }> {
  const parsed = checkSuiteWebhookSchema.safeParse(body);
  if (!parsed.success || parsed.data.action !== "completed") return [];
  const repository = parsed.data.repository;
  return parsed.data.check_suite.pull_requests
    .filter((pullRequest) =>
      isCheckSuiteRepositoryPullRequest(pullRequest, repository.id),
    )
    .map((pullRequest) => ({
      number: pullRequest.number,
      repositoryFullName: repository.full_name,
    }));
}

/** Identifiers and event types one completed check suite may publish. */
export function parseCheckSuitePublishTargets(body: unknown):
  | {
      data: { repo: string };
      eventTypes: string[];
      identifiers: string[];
    }
  | undefined {
  const parsed = checkSuiteWebhookSchema.safeParse(body);
  if (!parsed.success || parsed.data.action !== "completed") return undefined;
  const eventTypes = checkSuiteEventTypes(parsed.data.check_suite.conclusion);
  if (eventTypes.length === 0) return undefined;
  const repository = parsed.data.repository;
  const repo = repository.full_name;
  const identifiers = new Set<string>([
    gitHubRepositoryResource({ repo }).identifier,
  ]);
  for (const pullRequest of parsed.data.check_suite.pull_requests) {
    if (!isCheckSuiteRepositoryPullRequest(pullRequest, repository.id))
      continue;
    identifiers.add(
      gitHubPullRequestResource({ number: pullRequest.number, repo })
        .identifier,
    );
  }
  return {
    // Every copy sets this repo, so a broad trigger for another repo adds
    // no lazy keys.
    data: { repo: gitHubRepoDataSchema.parse(repo) },
    eventTypes,
    identifiers: [...identifiers],
  };
}

/**
 * True when a Watch or event automation may want `pull_request.checks.passed`
 * for this check suite, so the webhook reads the other suites on the commit
 * only then. A filter on a value that loads later counts as a match, so the
 * check never drops an Event that someone wants.
 */
export async function wantsCheckSuitePassed(args: {
  body: unknown;
  deliveryId: string;
  hasMatch: EventPublisher["hasMatch"];
  neededMatchKeys: EventPublisher["neededMatchKeys"];
}): Promise<boolean> {
  const targets = parseCheckSuitePublishTargets(args.body);
  if (!args.hasMatch || !targets?.eventTypes.includes(CHECKS_PASSED)) {
    return false;
  }
  const keys =
    (await args.neededMatchKeys?.({
      ...targets,
      eventTypes: [CHECKS_PASSED],
    })) ?? [];
  if (keys.some((key) => LATE_MATCH_KEYS.has(key))) return true;
  return await args.hasMatch(
    normalizeCheckSuiteEvents(args.deliveryId, args.body, {
      allCheckSuitesPassed: true,
    }).filter((event) => event.eventType === CHECKS_PASSED),
  );
}

/** Read which check suite values still need a GitHub API load. */
export function parseCheckSuiteFactsTarget(
  body: unknown,
  options?: { loadCheckSuites?: boolean; loadPullRequestFacts?: boolean },
):
  | {
      checkSuiteId: number;
      headSha: string;
      loadCheckSuites: boolean;
      loadFailingChecks: boolean;
      loadPullRequestFacts: boolean;
      owner: string;
      pullRequestNumbers: number[];
      repoName: string;
    }
  | undefined {
  const parsed = checkSuiteWebhookSchema.safeParse(body);
  if (!parsed.success || parsed.data.action !== "completed") return undefined;
  const conclusion = parsed.data.check_suite.conclusion;
  if (checkSuiteEventTypes(conclusion).length === 0) return undefined;
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
  const loadCheckSuites = Boolean(
    options?.loadCheckSuites && PASSING_SUITE_CONCLUSIONS.has(conclusion ?? ""),
  );
  if (!loadFailingChecks && !loadPullRequestFacts && !loadCheckSuites) {
    return undefined;
  }
  return {
    checkSuiteId,
    headSha,
    loadCheckSuites,
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
  if (typeof value["draft"] === "boolean") facts.isDraft = value["draft"];
  const user = value["user"];
  if (isRecord(user)) {
    const username =
      typeof user["login"] === "string" ? user["login"].trim() : undefined;
    if (username) facts.openerUsername = username;
    const email =
      typeof user["email"] === "string" ? user["email"].trim() : undefined;
    if (email) facts.openerEmail = email;
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

/**
 * Read every check suite on one commit and return whether all of them passed.
 * The suite that sent the webhook already passed. GitHub makes a queued suite
 * for each app that can write checks, even when the app never adds a check
 * run, so a queued suite with no check runs does not count. GitHub Actions
 * makes a suite only for a workflow that runs, and its suite can be queued
 * before it adds runs, so its suites always count. With more suites than the
 * pages read, the answer is false.
 */
async function loadAllCheckSuitesPassed(args: {
  checkSuiteId: number;
  headSha: string;
  owner: string;
  repoName: string;
  token: string;
}): Promise<boolean> {
  const suites: z.infer<typeof checkSuitesListResponseSchema>["check_suites"] =
    [];
  let totalCount = 0;
  for (let page = 1; page <= MAX_CHECK_SUITE_PAGES; page += 1) {
    const response = checkSuitesListResponseSchema.parse(
      await githubRequest(
        "https://api.github.com",
        `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repoName)}/commits/${args.headSha}/check-suites?per_page=100&page=${page}`,
        { token: args.token },
      ),
    );
    suites.push(...response.check_suites);
    totalCount = response.total_count;
    if (suites.length >= totalCount || response.check_suites.length === 0) {
      break;
    }
  }
  if (suites.length < totalCount) return false;
  return suites.every(
    (suite) =>
      suite.id === args.checkSuiteId ||
      (suite.status === "queued" &&
        suite.latest_check_runs_count === 0 &&
        suite.app?.slug !== "github-actions") ||
      (suite.status === "completed" &&
        PASSING_SUITE_CONCLUSIONS.has(suite.conclusion ?? "")),
  );
}

/**
 * Load failed check runs, whether every check suite on the commit passed,
 * and optional pull request match fields.
 */
export async function loadCheckSuiteFacts(args: {
  appIdEnv: string;
  body: unknown;
  installationIdEnv: string;
  /** Read the other suites on the commit for `pull_request.checks.passed`. */
  loadCheckSuites?: boolean;
  /** Open or recent githubstatus.com incidents, shared through a cache. */
  loadGitHubIncidents?(): Promise<GitHubStatusIncident[]>;
  loadPullRequestFacts?: boolean;
  log?: Pick<PluginLogger, "error" | "warn">;
  privateKeyEnv: string;
}): Promise<GitHubCheckSuiteFacts | undefined> {
  const target = parseCheckSuiteFactsTarget(args.body, {
    loadCheckSuites: args.loadCheckSuites,
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
      logFailOpenFailure(args.log, "GitHub check suite load failed", error, {
        checkSuiteId: target.checkSuiteId,
        repository: `${target.owner}/${target.repoName}`,
      });
    }
  }

  if (target.loadCheckSuites) {
    try {
      const token = await issueInstallationToken({
        appIdEnv: args.appIdEnv,
        installationIdEnv: args.installationIdEnv,
        permissions: { checks: "read" },
        privateKeyEnv: args.privateKeyEnv,
        repositories: [target.repoName],
      });
      if (
        await loadAllCheckSuitesPassed({
          checkSuiteId: target.checkSuiteId,
          headSha: target.headSha,
          owner: target.owner,
          repoName: target.repoName,
          token: token.token,
        })
      ) {
        facts.allCheckSuitesPassed = true;
      }
    } catch (error) {
      // The other events still publish. Without the suites, checks.passed
      // does not.
      logFailOpenFailure(
        args.log,
        "GitHub commit check suites load failed",
        error,
        {
          checkSuiteId: target.checkSuiteId,
          repository: `${target.owner}/${target.repoName}`,
        },
      );
    }
  }

  if (target.loadFailingChecks && args.loadGitHubIncidents) {
    // Fail open: a status page outage must not block the check event.
    try {
      const incidents = await args.loadGitHubIncidents();
      if (incidents.length > 0) facts.githubIncidents = incidents;
    } catch (error) {
      logFailOpenFailure(args.log, "GitHub status load failed", error, {});
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
              logFailOpenFailure(
                args.log,
                "GitHub pull request data load failed",
                error,
                {
                  pullRequest: number,
                  repository: `${target.owner}/${target.repoName}`,
                },
              );
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
      logFailOpenFailure(
        args.log,
        "GitHub check suite pull request data load failed",
        error,
        {
          checkSuiteId: target.checkSuiteId,
          repository: `${target.owner}/${target.repoName}`,
        },
      );
    }
  }

  return facts.failingChecks ||
    facts.allCheckSuitesPassed ||
    facts.pullRequestFactsByNumber
    ? facts
    : undefined;
}
