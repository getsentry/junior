/** Return true when a value is a Slack workspace/team id. */
export function isSlackTeamId(value: string): boolean {
  return /^T[A-Z0-9]+$/.test(value);
}

/** Return true when a value is a Slack conversation id. */
export function isSlackConversationId(value: string): boolean {
  return /^(C|G|D)[A-Z0-9]+$/.test(value);
}
