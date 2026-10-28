/** Repository page tabs. Overview is the bare repository path. */
export type CodeRepositoryTab = "overview" | "conversations" | "changes";

/** Tab order in the repository page navigation. */
export const codeRepositoryTabs: readonly CodeRepositoryTab[] = [
  "overview",
  "conversations",
  "changes",
];

/** Build the dashboard path for one repository page tab. */
export function codeRepositoryPath(
  repositoryId: string,
  tab: CodeRepositoryTab = "overview",
): string {
  const base = `/code/${encodeURIComponent(repositoryId)}`;
  return tab === "overview" ? base : `${base}/${tab}`;
}
