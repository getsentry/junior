import { Inbox } from "lucide-react";
import {
  createContext,
  use,
  useCallback,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { InboxItemPayload } from "@sentry/junior/api/schema";

import { Button } from "../components/ui/button";
import { scrollRootFor } from "../conversations/transcriptScrollRoot";
import {
  useEveryInboxItemPage,
  useInboxItemsData,
  useWaitingConversations,
} from "./queries";
import { itemConversationId, inboxItemWaitsForAnswer } from "./inboxItemFormat";

/**
 * Return the open questions that a Conversation's own Turns asked and that
 * wait on the viewer, oldest first. Each has a card in the transcript. An
 * Everyone question that the viewer has not taken does not count.
 */
export function useWaitingQuestions(conversationId: string | undefined) {
  // Every page reads which Conversations wait on the viewer, so a
  // Conversation that waits on no one sends no list read of its own.
  const waiting = useWaitingConversations();
  const { items, query } = useInboxItemsData({
    conversationId,
    enabled: Boolean(conversationId && waiting.has(conversationId)),
  });
  // The list keeps the items of the last Conversation while the new one
  // loads. Those questions are not for this Conversation.
  const stale = query.isPlaceholderData;
  // The list pages through every open item, notices too, so a question can
  // sit past the first page.
  useEveryInboxItemPage(query);
  // A plugin item and an item of another Conversation have no card here.
  return useMemo(
    () =>
      stale
        ? []
        : items.filter(
            (item) =>
              inboxItemWaitsForAnswer(item) &&
              !item.assignedToEveryone &&
              item.addedByTurnId !== undefined &&
              itemConversationId(item) === conversationId,
          ),
    [conversationId, items, stale],
  );
}

/**
 * Hold the ids of the question cards that show in the transcript's scroll
 * pane. Make one for each transcript.
 */
export function createQuestionsInViewStore() {
  const shown = new Set<string>();
  const listeners = new Set<() => void>();
  let version = 0;
  return {
    shows: (id: string) => shown.has(id),
    set(id: string, inView: boolean) {
      if (shown.has(id) === inView) return;
      if (inView) shown.add(id);
      else shown.delete(id);
      version += 1;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    version: () => version,
  };
}

/** The question cards in full view in the transcript that renders them. */
export const QuestionsInView = createContext<
  ReturnType<typeof createQuestionsInViewStore> | undefined
>(undefined);

// Ratios at which the card's view state is checked again.
const IN_VIEW_THRESHOLDS = Array.from({ length: 21 }, (_, step) => step / 20);

/**
 * Report whether the reader can see the whole question card on the returned
 * element, so its Send shows too. A card taller than most of the scroll pane
 * counts as in view once it fills that much of it. A card that unmounts no
 * longer shows.
 */
export function useQuestionInViewRef(itemId: string, waiting: boolean) {
  const store = use(QuestionsInView);
  return useCallback(
    (node: HTMLElement | null) => {
      if (!node || !store || !waiting) return;
      const root = scrollRootFor(node);
      const observer = new IntersectionObserver(
        ([entry]) => {
          if (!entry) return;
          const paneHeight = entry.rootBounds?.height ?? Infinity;
          store.set(
            itemId,
            entry.intersectionRatio > 0.98 ||
              entry.intersectionRect.height >= paneHeight * 0.8,
          );
        },
        {
          root: root instanceof HTMLElement ? root : null,
          threshold: IN_VIEW_THRESHOLDS,
        },
      );
      observer.observe(node);
      return () => {
        observer.disconnect();
        store.set(itemId, false);
      };
    },
    [itemId, store, waiting],
  );
}

/**
 * Say how many questions wait on the viewer while one of their cards is not
 * in full view. A click shows the oldest such card, so the next
 * click goes on to the next one.
 */
export function WaitingQuestionsPill(props: {
  onShow(item: InboxItemPayload): void;
  questions: readonly InboxItemPayload[];
  store: ReturnType<typeof createQuestionsInViewStore>;
}) {
  const { store } = props;
  useSyncExternalStore(store.subscribe, store.version, store.version);
  const next = props.questions.find((item) => !store.shows(item.id));
  if (!next) return null;
  const count = props.questions.length;
  const label = `${count} ${count === 1 ? "question" : "questions"} waiting`;
  return (
    <TranscriptPill
      icon={
        <Inbox
          aria-hidden="true"
          className="text-dashboard-accent-text"
          size={14}
          strokeWidth={2}
        />
      }
      onClick={() => props.onShow(next)}
    >
      {label}
    </TranscriptPill>
  );
}

/**
 * A pill above the message box that says what waits and goes to it. It
 * takes no focus and docks over nothing.
 */
export function TranscriptPill(props: {
  children: ReactNode;
  icon: ReactNode;
  onClick(): void;
}) {
  return (
    <Button
      className="pointer-events-auto h-8 -translate-y-full gap-1.5 rounded-full pl-3 pr-3.5 text-xs shadow-[0_4px_16px_rgba(0,0,0,0.12)]"
      onClick={props.onClick}
      variant="outline"
    >
      {props.icon}
      {props.children}
    </Button>
  );
}
