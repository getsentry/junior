import type { Conversation } from "../types";

/** Threads that the sidebar shows under one root before "Show N more". */
export const SIDEBAR_THREAD_LIMIT = 3;

/** One sidebar Thread row with its nesting depth under the root. */
type SidebarThread = { conversation: Conversation; depth: number };

/**
 * Pick the Threads that the sidebar shows under one root. A collapsed root
 * shows the Threads with the most recent activity, plus the open Thread.
 * Rows keep tree order, so a Thread stays under its parent.
 */
export function sidebarThreads(
  threads: readonly Conversation[] | undefined,
  options: { expanded: boolean; selectedId?: string },
): { hiddenCount: number; threads: SidebarThread[] } {
  const all = flattenThreads(threads ?? [], 0);
  if (options.expanded || all.length <= SIDEBAR_THREAD_LIMIT) {
    return { hiddenCount: 0, threads: all };
  }
  const shownIds = new Set(
    all
      .map((thread) => thread.conversation)
      .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))
      .slice(0, SIDEBAR_THREAD_LIMIT)
      .map((conversation) => conversation.id),
  );
  if (options.selectedId) shownIds.add(options.selectedId);
  const shown = all.filter((thread) => shownIds.has(thread.conversation.id));
  return { hiddenCount: all.length - shown.length, threads: shown };
}

function flattenThreads(
  threads: readonly Conversation[],
  depth: number,
): SidebarThread[] {
  return threads.flatMap((conversation) => [
    { conversation, depth },
    ...flattenThreads(conversation.threads ?? [], depth + 1),
  ]);
}
