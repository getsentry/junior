import type { ConversationStore } from "@/chat/conversations/store";
import { getConversationStore } from "@/chat/db";
import { getPersistedThreadState } from "@/chat/runtime/thread-state";
import { getSlackMessagePermalinkBestEffort } from "@/chat/slack/permalink";
import {
  coerceThreadConversationState,
  type ThreadConversationState,
} from "@/chat/state/conversation";

export type TranscriptConversationStore = Pick<
  ConversationStore,
  "get" | "listByActivity"
>;

export interface TranscriptToolDeps {
  conversationStore?: TranscriptConversationStore;
  getSlackLink?: (args: {
    channelId: string;
    messageTs: string;
  }) => Promise<string | undefined>;
  loadThreadState?: (
    conversationId: string,
  ) => Promise<Record<string, unknown>>;
}

export interface TranscriptToolResolvedDeps {
  conversationStore: TranscriptConversationStore;
  getSlackLink: (args: {
    channelId: string;
    messageTs: string;
  }) => Promise<string | undefined>;
  loadThreadState: (conversationId: string) => Promise<Record<string, unknown>>;
}

/** Resolve concrete services used by transcript tools at execution time. */
export function resolveTranscriptToolDeps(
  deps: TranscriptToolDeps = {},
): TranscriptToolResolvedDeps {
  return {
    conversationStore: deps.conversationStore ?? getConversationStore(),
    getSlackLink: deps.getSlackLink ?? getSlackMessagePermalinkBestEffort,
    loadThreadState: deps.loadThreadState ?? getPersistedThreadState,
  };
}

/** Load persisted transcript state using the canonical thread-state shape. */
export async function loadTranscriptState(
  deps: TranscriptToolResolvedDeps,
  conversationId: string,
): Promise<ThreadConversationState> {
  return coerceThreadConversationState(
    await deps.loadThreadState(conversationId),
  );
}
