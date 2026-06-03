const AUTH_PAUSE_RESPONSE =
  "I need authorization to continue. Check your private link to connect.";

/** Build the visible Slack thread note for an auth-paused turn. */
export function buildAuthPauseResponse(): string {
  return AUTH_PAUSE_RESPONSE;
}
