import type { EventMatch } from "@sentry/junior-plugin-api";
import { gitHubDeploymentSourceResource } from "./deployment.js";
import { gitHubIssueResource } from "./issue.js";
import { gitHubPullRequestResource } from "./pull-request.js";
import { gitHubReleaseSourceResource } from "./release.js";
import { gitHubRepositoryResource } from "./repository.js";

const REPO = String.raw`[^\s/:#]+\/[^\s/:#]+`;
const DEPLOYMENT_SOURCE = new RegExp(
  String.raw`^deployment-source:(${REPO})(?::([^\s:]+))?:([0-9a-f]{40})$`,
);
const RELEASE_SOURCE = new RegExp(
  String.raw`^release-source:(${REPO})(?::([^\s:]+))?$`,
);
const NUMBERED = new RegExp(String.raw`^(${REPO})#(\d+)$`);
const REPOSITORY = new RegExp(String.raw`^${REPO}$`);

function decoded(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/** Filters for one identifier, before the check that the plugin builds it. */
function identifierFilters(
  identifier: string,
  eventType: string,
): { match: EventMatch; built: string } | undefined {
  const deployment = DEPLOYMENT_SOURCE.exec(identifier);
  if (deployment) {
    if (!eventType.startsWith("deployment.")) return undefined;
    const [, repo, encodedEnvironment, commitSha] = deployment;
    const environment =
      encodedEnvironment === undefined
        ? undefined
        : decoded(encodedEnvironment);
    if (encodedEnvironment !== undefined && !environment) return undefined;
    return {
      match: {
        repo: repo!,
        commitSha: commitSha!,
        ...(environment ? { environment } : undefined),
      },
      built: gitHubDeploymentSourceResource({
        repo: repo!,
        commitSha: commitSha!,
        environment,
      }).identifier,
    };
  }
  const release = RELEASE_SOURCE.exec(identifier);
  if (release) {
    if (eventType !== "release.published") return undefined;
    const [, repo, encodedTag] = release;
    const tag = encodedTag === undefined ? undefined : decoded(encodedTag);
    if (encodedTag !== undefined && !tag) return undefined;
    return {
      match: { repo: repo!, ...(tag ? { tag } : undefined) },
      built: gitHubReleaseSourceResource({ repo: repo!, tag }).identifier,
    };
  }
  const numbered = NUMBERED.exec(identifier);
  if (numbered) {
    const repo = numbered[1]!;
    const number = Number(numbered[2]);
    if (eventType.startsWith("issue.")) {
      return {
        match: { repo, issue: number },
        built: gitHubIssueResource({ repo, number }).identifier,
      };
    }
    if (eventType.startsWith("pull_request.")) {
      return {
        match: { repo, pullRequest: number },
        built: gitHubPullRequestResource({ repo, number }).identifier,
      };
    }
    return undefined;
  }
  if (
    REPOSITORY.test(identifier) &&
    (eventType.startsWith("deployment.") ||
      eventType.startsWith("issue.") ||
      eventType.startsWith("pull_request."))
  ) {
    return {
      match: { repo: identifier },
      built: gitHubRepositoryResource({ repo: identifier }).identifier,
    };
  }
  return undefined;
}

/**
 * Turn a saved GitHub identifier into the filters that select the same
 * events of one type. Event data has the same lowercase values as
 * identifiers. Environment and tag parts are URI-encoded in identifiers, so
 * they are decoded. `owner/repo#n` names an issue on issue events and a pull
 * request on the others.
 *
 * The filters must rebuild the same identifier with the builder that the
 * webhooks use. Otherwise the identifier never got events, such as a tag that
 * was not encoded, and filters could match events that it never got.
 */
export function gitHubIdentifierMatch(input: {
  identifier: string;
  eventType: string;
}): EventMatch | undefined {
  const filters = identifierFilters(input.identifier, input.eventType);
  // Saved identifiers went through the plugin's `normalizeIdentifier`.
  if (!filters || filters.built.toLowerCase() !== input.identifier) {
    return undefined;
  }
  return filters.match;
}
