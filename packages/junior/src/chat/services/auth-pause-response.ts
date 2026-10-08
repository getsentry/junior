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

/**
 * Pick the reason text for an auth request: the agent's stated intent, else
 * the tool that hit the auth challenge. Returns undefined when neither exists
 * so callers can fall back to the user's message.
 */
export function describeAuthorizationReason(context?: {
  intent?: string;
  toolName?: string;
}): string | undefined {
  const intent = context?.intent?.trim();
  if (intent) {
    return intent;
  }
  const toolName = context?.toolName?.replaceAll("`", "").trim();
  return toolName ? `calling \`${toolName}\`` : undefined;
}

/** Build the visible Slack thread note for an auth-paused turn. */
export function buildAuthPauseResponse(
  slackUserId: string | undefined,
  providerDisplayName: string,
  requestText?: string,
): string {
  const mention = slackUserId ? `<@${slackUserId}> ` : "";
  const request = requestText ? formatAuthRequest(requestText) : undefined;
  const notice = `${mention}I need access to your ${providerDisplayName} account to continue. I sent you a private link.`;
  return request ? `${notice}\n\n*Why:* ${request}` : notice;
}
