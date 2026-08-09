import {
  githubRequest,
  issueInstallationToken,
} from "../credential-support.js";
import {
  parseCheckSuiteEnrichmentTarget,
  selectFailingChecks,
  type GitHubFailingCheck,
} from "./resource-events.js";

function checkRunsFromResponse(value: unknown): unknown[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const checkRuns = (value as { check_runs?: unknown }).check_runs;
  return Array.isArray(checkRuns) ? checkRuns : [];
}

/** Load failed check-run names and urls for a failed check suite. */
export async function loadFailingChecksForSuite(args: {
  appIdEnv: string;
  body: unknown;
  installationIdEnv: string;
  log?: { error(message: string, metadata?: Record<string, unknown>): void };
  privateKeyEnv: string;
}): Promise<GitHubFailingCheck[] | undefined> {
  const target = parseCheckSuiteEnrichmentTarget(args.body);
  if (!target) return undefined;

  try {
    const token = await issueInstallationToken({
      appIdEnv: args.appIdEnv,
      installationIdEnv: args.installationIdEnv,
      permissions: { checks: "read" },
      privateKeyEnv: args.privateKeyEnv,
      repositories: [target.repoName],
    });
    const response = await githubRequest(
      "https://api.github.com",
      `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repoName)}/commits/${encodeURIComponent(target.headSha)}/check-runs?filter=latest&per_page=100`,
      { token: token.token },
    );
    const failing = selectFailingChecks(checkRunsFromResponse(response));
    return failing.length > 0 ? failing : undefined;
  } catch (error) {
    args.log?.error("GitHub check suite enrichment failed", {
      checkSuiteId: target.checkSuiteId,
      errorType: error instanceof Error ? error.name : "UnknownError",
      repository: `${target.owner}/${target.repoName}`,
    });
    return undefined;
  }
}
