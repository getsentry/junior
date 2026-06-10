/**
 * Build the visible Slack thread note for an auth-paused turn.
 * Mentions the requester when a Slack user ID is supplied, and names
 * the provider when known.
 */
export function buildAuthPauseResponse(
  slackUserId?: string,
  provider?: string,
): string {
  const mention = slackUserId ? `<@${slackUserId}> ` : "";
  const subject = provider ? `authorize ${provider}` : "connect an account";
  return `${mention}I'll need you to ${subject}. I sent you a link.`;
}
