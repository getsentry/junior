import { useEffect } from "react";

import { getDashboardAgentName } from "./agentName";

/** Format a browser tab title as `{page} - {agent}`, or the agent name alone. */
export function formatDocumentTitle(
  title: string | undefined,
  agentName = getDashboardAgentName(),
): string {
  const page = title?.trim();
  return page ? `${page} - ${agentName}` : agentName;
}

/**
 * Show the current page in the browser tab title.
 *
 * An empty title leaves the tab alone, so a parent without a title cannot
 * replace a child's title. Unmount restores the agent name.
 */
export function useDocumentTitle(title: string | undefined): void {
  useEffect(() => {
    if (!title?.trim()) return;
    document.title = formatDocumentTitle(title);
    return () => {
      document.title = formatDocumentTitle(undefined);
    };
  }, [title]);
}
