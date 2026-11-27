import { Inbox } from "lucide-react";
import {
  createContext,
  use,
  useCallback,
  useMemo,
  useSyncExternalStore,
} from "react";
import {
  inboxItemQuestion,
  type ConversationReportEvent,
} from "@sentry/junior/api/schema";

import { Button } from "../components/ui/button";
import {
  transcriptAsks,
  useConversationQuestions,
} from "../conversations/conversationQuestions";
import { scrollRootFor } from "../conversations/transcriptScrollRoot";
import { useViewerWaits } from "./queries";

/** A question card in the transcript that waits on the viewer. */
export type WaitingQuestion = {
  itemId: string;
  /** The Turn that asked it, so the page can load the rows around it. */
  turnId?: string | undefined;
};

/**
 * Return the questions of a Conversation's loaded transcript that wait on
 * the viewer, oldest first. Each has a card there. A question waits when
 * the Inbox says its item waits on the viewer and it has no answer yet, so
 * an Everyone question that the viewer has not taken does not count.
 */
export function useWaitingQuestions(
  conversationId: string | undefined,
  events: readonly ConversationReportEvent[] | undefined,
): WaitingQuestion[] {
  const { itemIds } = useViewerWaits();
  const asks = useMemo(
    () =>
      conversationId
        ? transcriptAsks(events).filter((ask) => itemIds.has(ask.itemId))
        : [],
    [conversationId, events, itemIds],
  );
  // A Conversation with no waiting card sends no read of its own.
  const questions = useConversationQuestions(conversationId ?? "", {
    enabled: asks.length > 0,
  }).data?.questions;
  return useMemo(
    () =>
      asks.flatMap((ask) => {
        const question = questions?.find(
          (entry) => entry.id === ask.questionId,
        );
        return question &&
          !question.answer &&
          inboxItemQuestion(question.request)
          ? [{ itemId: ask.itemId, turnId: question.turnId }]
          : [];
      }),
    [asks, questions],
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
  onShow(question: WaitingQuestion): void;
  questions: readonly WaitingQuestion[];
  store: ReturnType<typeof createQuestionsInViewStore>;
}) {
  const { store } = props;
  useSyncExternalStore(store.subscribe, store.version, store.version);
  const next = props.questions.find(
    (question) => !store.shows(question.itemId),
  );
  if (!next) return null;
  const count = props.questions.length;
  const label = `${count} ${count === 1 ? "question" : "questions"} waiting`;
  return (
    <Button
      className="pointer-events-auto h-8 -translate-y-full gap-1.5 rounded-full pl-3 pr-3.5 text-xs shadow-[0_4px_16px_rgba(0,0,0,0.12)]"
      onClick={() => props.onShow(next)}
      variant="outline"
    >
      <Inbox
        aria-hidden="true"
        className="text-dashboard-accent-text"
        size={14}
        strokeWidth={2}
      />
      {label}
    </Button>
  );
}
