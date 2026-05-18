/** Normalize the configured GitHub mention handle used for trigger matching. */
export function normalizeGitHubMentionTarget(userName: string): string {
  return userName
    .trim()
    .replace(/^@/, "")
    .replace(/\[bot\]$/i, "");
}

/** Return the mention handles a GitHub App user may appear as in comments. */
export function getGitHubMentionTargets(userName: string): string[] {
  const configuredTarget = userName.trim().replace(/^@/, "");
  const normalizedTarget = normalizeGitHubMentionTarget(userName);
  const appTarget = normalizedTarget ? `${normalizedTarget}[bot]` : "";
  return [
    ...new Set([configuredTarget, normalizedTarget, appTarget].filter(Boolean)),
  ];
}
