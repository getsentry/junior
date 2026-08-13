/**
 * Deterministic pull request review policy enforced before credential grant.
 */
import { EgressPolicyDenied } from "@sentry/junior-plugin-api";
import { isRecord } from "./credential-support.js";

/** Deny APPROVE while allowing change requests, comments, and dismissals. */
export function assertGitHubPullRequestApprovalDenied(input: {
  bodyText?: string;
  method: string;
  upstreamUrl: URL;
}): void {
  if (
    input.method !== "POST" ||
    input.upstreamUrl.hostname.toLowerCase() !== "api.github.com"
  ) {
    return;
  }
  const match = input.upstreamUrl.pathname
    .toLowerCase()
    .match(
      /^\/repos\/[^/]+\/[^/]+\/pulls\/[^/]+\/reviews(?:\/[^/]+\/(events))?$/,
    );
  if (!match) return;

  const isEventsPath = match[1] === "events";
  const bodyText = input.bodyText?.trim() ?? "";
  // Empty create body is a pending review. The events path always needs a body.
  if (!bodyText) {
    if (isEventsPath) {
      throw new EgressPolicyDenied(
        "GitHub pull request review submissions must include a parseable non-APPROVE event so Junior can enforce the no-approve policy.",
      );
    }
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new EgressPolicyDenied(
      "GitHub pull request review requests must use JSON bodies so Junior can enforce the no-approve policy.",
    );
  }
  if (!isRecord(body)) {
    throw new EgressPolicyDenied(
      "GitHub pull request review requests must use JSON object bodies so Junior can enforce the no-approve policy.",
    );
  }

  let event: string | undefined;
  if ("event" in body) {
    if (typeof body.event !== "string" || body.event.trim().length === 0) {
      throw new EgressPolicyDenied(
        "GitHub pull request review submissions must include a parseable non-APPROVE event so Junior can enforce the no-approve policy.",
      );
    }
    event = body.event.trim().toUpperCase();
  }
  if (event === "APPROVE") {
    throw new EgressPolicyDenied(
      "Junior cannot approve GitHub pull requests. Request changes, leave a comment review, or dismiss Junior's own review instead.",
    );
  }
  if (isEventsPath && event === undefined) {
    throw new EgressPolicyDenied(
      "GitHub pull request review submissions must include a parseable non-APPROVE event so Junior can enforce the no-approve policy.",
    );
  }
}
