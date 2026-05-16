/** Normalize the configured GitHub mention handle used for trigger matching. */
export function normalizeGitHubMentionTarget(userName: string): string {
  return userName
    .trim()
    .replace(/^@/, "")
    .replace(/\[bot\]$/i, "");
}
