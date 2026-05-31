/** Preserve skipped Slack messages as model input without duplicating stored turn state. */
export function combineQueuedUserText(
  queuedMessages: Array<{ userText: string }>,
  latestUserText: string,
): string {
  const parts = [
    ...queuedMessages.map((message) => message.userText),
    latestUserText,
  ].filter((part) => part.trim().length > 0);
  return parts.length > 0 ? parts.join("\n\n") : latestUserText;
}
