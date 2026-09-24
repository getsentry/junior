const MAX_AUTH_REQUEST_LENGTH = 200;

function formatAuthRequest(requestText: string): string | undefined {
  const normalized = requestText.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  const bounded =
    normalized.length > MAX_AUTH_REQUEST_LENGTH
      ? `${normalized.slice(0, MAX_AUTH_REQUEST_LENGTH - 1).trimEnd()}…`
      : normalized;
  return bounded
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** Build the visible Slack thread note for an auth-paused turn. */
export function buildAuthPauseResponse(
  slackUserId: string | undefined,
  providerDisplayName: string,
  requestText?: string,
): string {
  const mention = slackUserId ? `<@${slackUserId}> ` : "";
  const request = requestText ? formatAuthRequest(requestText) : undefined;
  if (!request) {
    return `${mention}I'll need you to authorize ${providerDisplayName}. I sent you a link.`;
  }
  return `${mention}I need access to ${providerDisplayName} to continue.\n\n*Why:* ${request}\n\nI sent you a link.`;
}
