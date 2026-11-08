import { createContext, useContext } from "react";

import type { Conversation } from "../types";

/**
 * Map each Thread in the feed, at any depth, to its feed row. The feed holds
 * shown Threads only, so an archived Thread is not in it.
 */
export function feedThreadsById(
  conversations: readonly Conversation[],
  threads = new Map<string, Conversation>(),
): Map<string, Conversation> {
  for (const conversation of conversations) {
    if (!conversation.threads) continue;
    for (const thread of conversation.threads) {
      threads.set(thread.id, thread);
    }
    feedThreadsById(conversation.threads, threads);
  }
  return threads;
}

/** The feed Threads of the open page, for rows deep in its transcript. */
export const FeedThreads = createContext<ReadonlyMap<string, Conversation>>(
  new Map(),
);

/** Return the feed row of one Thread, when the feed shows it. */
export function useFeedThread(id: string): Conversation | undefined {
  return useContext(FeedThreads).get(id);
}
