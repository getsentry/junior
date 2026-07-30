/** Build the visible Slack thread note for an auth-paused turn. */
export function buildAuthPauseResponse(
  slackUserId: string | undefined,
  providerDisplayName: string,
): string {
  const mention = slackUserId ? `<@${slackUserId}> ` : "";
  return `${mention}I'll need you to authorize ${providerDisplayName}. I sent you a link.`;
}
