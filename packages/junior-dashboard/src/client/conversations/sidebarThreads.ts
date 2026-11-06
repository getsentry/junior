import type { Conversation } from "../types";

/** Threads that the sidebar shows under one root before "Show N more". */
const SIDEBAR_THREAD_LIMIT = 3;

/** One sidebar Thread row with its nesting depth under the root. */
type SidebarThread = { conversation: Conversation; depth: number };

/**
 * Pick the Threads that the sidebar shows under one root. A collapsed root
 * shows its direct Threads with the most recent activity, plus the direct
 * Thread that holds the open Thread. A nested Thread shows only under its
 * shown parent, so a row never sits under an unrelated Thread.
 */
export function sidebarThreads(
  threads: readonly Conversation[] | undefined,
  options: { expanded: boolean; selectedId?: string },
): { collapsible: boolean; hiddenCount: number; threads: SidebarThread[] } {
  const direct = threads ?? [];
  const all = flattenThreads(direct, 0);
  const collapsible = direct.length > SIDEBAR_THREAD_LIMIT;
  if (options.expanded || !collapsible) {
    return { collapsible, hiddenCount: 0, threads: all };
  }
  const shownIds = new Set(
    [...direct]
      .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))
      .slice(0, SIDEBAR_THREAD_LIMIT)
      .map((conversation) => conversation.id),
  );
  const selectedId = options.selectedId;
  const open = selectedId
    ? direct.find((conversation) => holdsThread(conversation, selectedId))
    : undefined;
  if (open) shownIds.add(open.id);
  const shown = flattenThreads(
    direct.filter((conversation) => shownIds.has(conversation.id)),
    0,
  );
  return {
    collapsible,
    hiddenCount: all.length - shown.length,
    threads: shown,
  };
}

function holdsThread(conversation: Conversation, id: string): boolean {
  return (
    conversation.id === id ||
    (conversation.threads ?? []).some((thread) => holdsThread(thread, id))
  );
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
