import { useEffect, useMemo, useState } from "react";

import type { Conversation } from "../types";

const STORAGE_KEY = "junior:conversation-finished-indicators";

type StoredConversationState = {
  lastReadAt: string;
};

type StoredConversationStates = Record<string, StoredConversationState>;

/** Track visible idle conversations that have activity after the user read them. */
export function useConversationFinishedIndicators(
  conversations: Conversation[],
  selectedId: string | undefined,
  ready: boolean,
  pruneMissing: boolean,
): ReadonlySet<string> {
  const [storedStates, setStoredStates] = useState(readStoredStates);

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

  return useMemo(
    () => finishedConversationIds(storedStates, conversations, selectedId),
    [conversations, selectedId, storedStates],
  );
}

/** Find idle conversations with activity after the user read them. */
export function finishedConversationIds(
  states: StoredConversationStates,
  conversations: Conversation[],
  selectedId: string | undefined,
): ReadonlySet<string> {
  return new Set(
    conversations
      .filter((conversation) => {
        const state = states[conversation.id];
        return (
          conversation.id !== selectedId &&
          conversation.status === "completed" &&
          state !== undefined &&
          isAfter(conversation.lastSeenAt, state.lastReadAt)
        );
      })
      .map((conversation) => conversation.id),
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
