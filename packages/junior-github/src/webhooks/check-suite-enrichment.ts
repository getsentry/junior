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
} from "./resource-events.js";

function checkRunsFromResponse(value: unknown): unknown[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const checkRuns = (value as { check_runs?: unknown }).check_runs;
  return Array.isArray(checkRuns) ? checkRuns : [];
}

function pullRequestDraftFromResponse(value: unknown): boolean | undefined {
  if (!isRecord(value) || typeof value.draft !== "boolean") {
    return undefined;
  }
  return value.draft;
}

/** Load failed check runs and missing pull request draft facts for one suite. */
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

  if (target.pullRequestNumbersMissingDraft.length > 0) {
    try {
      const token = await issueInstallationToken({
        appIdEnv: args.appIdEnv,
        installationIdEnv: args.installationIdEnv,
        permissions: { pull_requests: "read" },
        privateKeyEnv: args.privateKeyEnv,
        repositories: [target.repoName],
      });
      const drafts = await Promise.all(
        target.pullRequestNumbersMissingDraft.map(async (number) => {
          try {
            const response = await githubRequest(
              "https://api.github.com",
              `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repoName)}/pulls/${number}`,
              { token: token.token },
            );
            const draft = pullRequestDraftFromResponse(response);
            return draft === undefined ? undefined : ([number, draft] as const);
          } catch (error) {
            args.log?.error("GitHub pull request draft enrichment failed", {
              errorType: error instanceof Error ? error.name : "UnknownError",
              pullRequest: number,
              repository: `${target.owner}/${target.repoName}`,
            });
            return undefined;
          }
        }),
      );
      const pullRequestDraftByNumber: Record<number, boolean> = {};
      for (const entry of drafts) {
        if (!entry) continue;
        pullRequestDraftByNumber[entry[0]] = entry[1];
      }
      if (Object.keys(pullRequestDraftByNumber).length > 0) {
        enrichment.pullRequestDraftByNumber = pullRequestDraftByNumber;
      }
    } catch (error) {
      args.log?.error("GitHub check suite draft enrichment failed", {
        checkSuiteId: target.checkSuiteId,
        errorType: error instanceof Error ? error.name : "UnknownError",
        repository: `${target.owner}/${target.repoName}`,
      });
    }
  }

  return enrichment.failingChecks || enrichment.pullRequestDraftByNumber
    ? enrichment
    : undefined;
}
