/**
 * Load extra check-suite facts GitHub omits from the webhook body.
 */
import {
  githubRequest,
  isRecord,
  issueInstallationToken,
} from "../credential-support.js";
import {
  parseCheckSuiteEnrichmentTarget,
  selectFailingChecks,
  type GitHubCheckSuiteEnrichment,
  type GitHubCheckSuitePullRequestFacts,
} from "./check-suite-resource-events.js";

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

/** Load failed check runs and missing pull request facts for one suite. */
export async function loadCheckSuiteEnrichment(args: {
  appIdEnv: string;
  body: unknown;
  installationIdEnv: string;
  log?: { error(message: string, metadata?: Record<string, unknown>): void };
  privateKeyEnv: string;
}): Promise<GitHubCheckSuiteEnrichment | undefined> {
  const target = parseCheckSuiteEnrichmentTarget(args.body);
  if (!target) return undefined;

  const enrichment: GitHubCheckSuiteEnrichment = {};

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
      if (failing.length > 0) enrichment.failingChecks = failing;
    } catch (error) {
      args.log?.error("GitHub check suite enrichment failed", {
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
            args.log?.error("GitHub pull request fact enrichment failed", {
              errorType: error instanceof Error ? error.name : "UnknownError",
              pullRequest: number,
              repository: `${target.owner}/${target.repoName}`,
            });
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
        enrichment.pullRequestFactsByNumber = pullRequestFactsByNumber;
      }
    } catch (error) {
      args.log?.error("GitHub check suite pull request enrichment failed", {
        checkSuiteId: target.checkSuiteId,
        errorType: error instanceof Error ? error.name : "UnknownError",
        repository: `${target.owner}/${target.repoName}`,
      });
    }
  }

  return enrichment.failingChecks || enrichment.pullRequestFactsByNumber
    ? enrichment
    : undefined;
}
