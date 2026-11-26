import type { Conversation } from "../types";
import { attentionOrder } from "./conversationSections";

/** Threads that the sidebar shows under one root before "Show N more". */
const SIDEBAR_THREAD_LIMIT = 3;

/** One sidebar Thread row with its nesting depth under the root. */
type SidebarThread = { conversation: Conversation; depth: number };

/**
 * Pick the Threads that the sidebar shows under one root, in
 * `attentionOrder` at each level, as the Threads panel shows them. A
 * collapsed root shows its first direct Threads in that order, plus the
 * direct Thread that holds the open Thread. A nested Thread shows only under its
 * shown parent, so a row never sits under an unrelated Thread.
 * `omittedCount` is the root's Threads that the feed left out; it shows only
 * once every loaded Thread shows.
 */
export function sidebarThreads(
  root: Pick<Conversation, "omittedThreadCount" | "threads">,
  options: { expanded: boolean; selectedId?: string | undefined },
): {
  collapsible: boolean;
  hiddenCount: number;
  omittedCount: number;
  threads: SidebarThread[];
} {
  const direct = attentionOrder(root.threads ?? []);
  const all = flattenThreads(direct, 0);
  const collapsible = direct.length > SIDEBAR_THREAD_LIMIT;
  if (options.expanded || !collapsible) {
    return {
      collapsible,
      hiddenCount: 0,
      omittedCount: root.omittedThreadCount ?? 0,
      threads: all,
    };
  }
  const shownIds = new Set(
    direct
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
  const hiddenCount = all.length - shown.length;
  return {
    collapsible,
    hiddenCount,
    omittedCount: hiddenCount === 0 ? (root.omittedThreadCount ?? 0) : 0,
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
    ...flattenThreads(attentionOrder(conversation.threads ?? []), depth + 1),
  ]);
}
