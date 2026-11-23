import { NAV_PAGES } from "../../navPages";

/** What Code shows: the viewer's own pull requests, or every repository. */
export type CodeScope = "all" | "mine";

/** The search param that holds the Code scope. Mine is the default. */
export const CODE_SCOPE_PARAM = "scope";

/** Code · All, which lists every repository. */
export const CODE_ALL_PATH = `${NAV_PAGES.code.to}?${CODE_SCOPE_PARAM}=all`;

/** Read the Code scope from the URL. Other values show Mine. */
export function codeScopeOf(search: URLSearchParams): CodeScope {
  return search.get(CODE_SCOPE_PARAM) === "all" ? "all" : "mine";
}

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
