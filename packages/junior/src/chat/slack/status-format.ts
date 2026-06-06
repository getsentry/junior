// Slack assistant.threads.setStatus enforces a 50-char limit on the status field.
const SLACK_STATUS_MAX_LENGTH = 50;

/** Truncate a status string to fit Slack's 50-char assistant status limit. */
export function truncateStatusText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= SLACK_STATUS_MAX_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, SLACK_STATUS_MAX_LENGTH - 3).trimEnd()}...`;
}
