/**
 * Deterministic GitHub write denials enforced before credential grant.
 */
import { EgressPolicyDenied } from "@sentry/junior-plugin-api";
import { isRecord } from "./credential-support.js";

function isGitHubApiUrl(upstreamUrl: URL): boolean {
  return upstreamUrl.hostname.toLowerCase() === "api.github.com";
}

function isGitHubPullRequestReviewCreateRestRequest(
  method: string,
  upstreamUrl: URL,
): boolean {
  return (
    method === "POST" &&
    isGitHubApiUrl(upstreamUrl) &&
    /^\/repos\/[^/]+\/[^/]+\/pulls\/[^/]+\/reviews$/.test(
      upstreamUrl.pathname.toLowerCase(),
    )
  );
}

function isGitHubPullRequestReviewEventRestRequest(
  method: string,
  upstreamUrl: URL,
): boolean {
  return (
    method === "POST" &&
    isGitHubApiUrl(upstreamUrl) &&
    /^\/repos\/[^/]+\/[^/]+\/pulls\/[^/]+\/reviews\/[^/]+\/events$/.test(
      upstreamUrl.pathname.toLowerCase(),
    )
  );
}

function parseGitHubPullRequestReviewEvent(
  bodyText: string | undefined,
): string | undefined {
  if (typeof bodyText !== "string" || bodyText.trim().length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed.event !== "string") {
    return undefined;
  }
  const event = parsed.event.trim().toUpperCase();
  return event.length > 0 ? event : undefined;
}

/** Deny APPROVE while still allowing REQUEST_CHANGES, COMMENT, and dismissals. */
export function assertGitHubPullRequestApprovalDenied(input: {
  bodyText?: string;
  method: string;
  upstreamUrl: URL;
}): void {
  const isReviewCreate = isGitHubPullRequestReviewCreateRestRequest(
    input.method,
    input.upstreamUrl,
  );
  const isReviewEvent = isGitHubPullRequestReviewEventRestRequest(
    input.method,
    input.upstreamUrl,
  );
  if (!isReviewCreate && !isReviewEvent) {
    return;
  }

  const event = parseGitHubPullRequestReviewEvent(input.bodyText);
  if (event === "APPROVE") {
    throw new EgressPolicyDenied(
      "Junior cannot approve GitHub pull requests. Request changes, leave a comment review, or dismiss Junior's own review instead.",
    );
  }
  if (isReviewEvent && event === undefined) {
    throw new EgressPolicyDenied(
      "GitHub pull request review submissions must include a parseable non-APPROVE event so Junior can enforce the no-approve policy.",
    );
  }
  // Pending review creates may omit event. Keep those allowed.
}
