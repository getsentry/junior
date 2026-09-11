import { useEffect, useMemo, useState } from "react";

import type { Conversation } from "../types";

const STORAGE_KEY = "junior:conversation-finished-indicators";

type StoredConversationState = {
  finishedSinceSeen: boolean;
  status: Conversation["status"];
};

type StoredConversationStates = Record<string, StoredConversationState>;

/** Track visible conversations that completed after the user last saw them active. */
export function useConversationFinishedIndicators(
  conversations: Conversation[],
  selectedId: string | undefined,
  ready: boolean,
): ReadonlySet<string> {
  const [storedStates, setStoredStates] = useState(readStoredStates);

  useEffect(() => {
    if (!ready) return;

    setStoredStates((current) => {
      const next = reconcileStoredStates(current, conversations, selectedId);
      writeStoredStates(next);
      return next;
    });
  }, [conversations, ready, selectedId]);

  return useMemo(
    () =>
      new Set(
        Object.entries(storedStates)
          .filter(([, state]) => state.finishedSinceSeen)
          .map(([conversationId]) => conversationId),
      ),
    [storedStates],
  );
}

/** Update completion markers and remove conversations outside the visible list. */
export function reconcileStoredStates(
  current: StoredConversationStates,
  conversations: Conversation[],
  selectedId: string | undefined,
): StoredConversationStates {
  return Object.fromEntries(
    conversations.map((conversation) => {
      const previous = current[conversation.id];
      const finishedSinceSeen =
        conversation.id !== selectedId &&
        conversation.status === "completed" &&
        (previous?.finishedSinceSeen || previous?.status === "active");

      return [
        conversation.id,
        { finishedSinceSeen, status: conversation.status },
      ];
    }),
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
            "finishedSinceSeen" in state &&
            typeof state.finishedSinceSeen === "boolean" &&
            "status" in state &&
            (state.status === "active" ||
              state.status === "completed" ||
              state.status === "failed")
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
