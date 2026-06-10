const AUTH_PAUSE_RESPONSE_BODY =
  "need you to connect an account before I can continue — check your private link.";

/**
 * Build the visible Slack thread note for an auth-paused turn.
 * When a Slack user ID is supplied the message is prefixed with a mention
 * so the requester is notified directly in the thread.
 */
export function buildAuthPauseResponse(slackUserId?: string): string {
  const mention = slackUserId ? `<@${slackUserId}> ` : "";
  return `${mention}${AUTH_PAUSE_RESPONSE_BODY}`;
}
