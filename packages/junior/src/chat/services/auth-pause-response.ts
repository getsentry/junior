/**
 * Build the visible Slack thread note for an auth-paused turn.
 * Mentions the requester when a Slack user ID is supplied, and names
 * the provider when known.
 */
export function buildAuthPauseResponse(
  slackUserId: string | undefined,
  provider: string,
): string {
  const mention = slackUserId ? `<@${slackUserId}> ` : "";
  return `${mention}I'll need you to authorize ${provider}. I sent you a link.`;
}
