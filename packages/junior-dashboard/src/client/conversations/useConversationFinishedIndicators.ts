import { useCallback, useEffect, useMemo, useState } from "react";

import type { Conversation } from "../types";

const STORAGE_KEY = "junior:conversation-finished-indicators";

type StoredConversationState = {
  lastReadAt: string;
};

type StoredConversationStates = Record<string, StoredConversationState>;

type ConversationFinishedIndicators = {
  finishedConversationIds: ReadonlySet<string>;
  /**
   * The selected conversation when it was unread at the moment it opened.
   * Lists keep it in its unread place until another conversation opens, so
   * the row does not move under the pointer.
   */
  heldConversationId?: string;
  markRead(conversationId: string, lastReadAt: string): void;
  markUnread(conversation: Conversation): void;
};

/** Track visible idle conversations that have activity after the user read them. */
export function useConversationFinishedIndicators(
  conversations: Conversation[],
  selectedId: string | undefined,
  ready: boolean,
  pruneMissing: boolean,
): ConversationFinishedIndicators {
  const [storedStates, setStoredStates] = useState(readStoredStates);
  const [held, setHeld] = useState<{ heldId?: string; selectedId?: string }>(
    {},
  );
  // Read the unread state when the selection changes, before the effect
  // below or the opened page marks it read. Hold only a row that the list
  // already showed. A deep link has no row under the pointer, and the
  // selected row never leads its section, so it does not move.
  if (held.selectedId !== selectedId) {
    const selected = conversations.find(({ id }) => id === selectedId);
    setHeld({
      heldId:
        selected && finishedSinceRead(storedStates, selected)
          ? selected.id
          : undefined,
      selectedId,
    });
  }

  useEffect(() => {
    if (!ready) return;

    setStoredStates((current) => {
      const next = reconcileStoredStates(
        current,
        conversations,
        selectedId,
        pruneMissing,
      );
      writeStoredStates(next);
      return next;
    });
  }, [conversations, pruneMissing, ready, selectedId]);

  const markRead = useCallback((conversationId: string, lastReadAt: string) => {
    setStoredStates((current) => {
      const previous = current[conversationId];
      if (previous && !isAfter(lastReadAt, previous.lastReadAt)) return current;

      const next = { ...current, [conversationId]: { lastReadAt } };
      writeStoredStates(next);
      return next;
    });
  }, []);

  // Move the read time just before the last activity, so the row reads as
  // finished since read until the user opens it again.
  const markUnread = useCallback((conversation: Conversation) => {
    const lastSeenMs = Date.parse(conversation.lastSeenAt);
    if (!Number.isFinite(lastSeenMs)) return;

    setStoredStates((current) => {
      const next = {
        ...current,
        [conversation.id]: {
          lastReadAt: new Date(lastSeenMs - 1).toISOString(),
        },
      };
      writeStoredStates(next);
      return next;
    });
  }, []);

  return {
    finishedConversationIds: useMemo(
      () => finishedConversationIds(storedStates, conversations, selectedId),
      [conversations, selectedId, storedStates],
    ),
    heldConversationId: held.heldId,
    markRead,
    markUnread,
  };
}

/** Find idle conversations with activity after the user read them. */
export function finishedConversationIds(
  states: StoredConversationStates,
  conversations: Conversation[],
  selectedId: string | undefined,
): ReadonlySet<string> {
  return new Set(
    conversations
      .filter(
        (conversation) =>
          conversation.id !== selectedId &&
          finishedSinceRead(states, conversation),
      )
      .map((conversation) => conversation.id),
  );
}

function finishedSinceRead(
  states: StoredConversationStates,
  conversation: Conversation,
): boolean {
  const state = states[conversation.id];
  return (
    conversation.status === "completed" &&
    state !== undefined &&
    isAfter(conversation.lastSeenAt, state.lastReadAt)
  );
}

/** Record reads and remove conversations outside the visible list. */
export function reconcileStoredStates(
  current: StoredConversationStates,
  conversations: Conversation[],
  selectedId: string | undefined,
  pruneMissing = true,
): StoredConversationStates {
  const visibleStates = Object.fromEntries(
    conversations.map((conversation) => {
      const previous = current[conversation.id];
      const lastReadAt =
        conversation.id === selectedId || previous === undefined
          ? conversation.lastSeenAt
          : previous.lastReadAt;

      return [conversation.id, { lastReadAt }];
    }),
  );
  if (pruneMissing) return visibleStates;
  return { ...current, ...visibleStates };
}

function isAfter(value: string, reference: string): boolean {
  const valueTime = Date.parse(value);
  const referenceTime = Date.parse(reference);
  return (
    Number.isFinite(valueTime) &&
    Number.isFinite(referenceTime) &&
    valueTime > referenceTime
  );
}

function readStoredStates(): StoredConversationStates {
  if (typeof window === "undefined") return {};

  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? "{}",
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};

    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, StoredConversationState] => {
          const state: unknown = entry[1];
          return (
            state !== null &&
            typeof state === "object" &&
            "lastReadAt" in state &&
            typeof state.lastReadAt === "string" &&
            Number.isFinite(Date.parse(state.lastReadAt))
          );
        },
      ),
    );
  } catch {
    return {};
  }
}

function writeStoredStates(states: StoredConversationStates): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(states));
  } catch {
    // Keep in-memory indicators usable when storage is unavailable.
  }
}
