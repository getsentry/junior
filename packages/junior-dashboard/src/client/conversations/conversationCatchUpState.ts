/**
 * Offer a catch-up when a reader comes back to a lot of unread activity. The
 * reader asks for it, because each summary costs a model call and a short
 * wait.
 */
import { useMutation } from "@tanstack/react-query";
import { createContext, useContext } from "react";

import {
  conversationCatchUpSchema,
  type ConversationCatchUp,
  type ConversationDetailReport,
} from "@sentry/junior/api/schema";
import { post } from "../http";
import type { TranscriptUnreadRange } from "./transcriptReadPosition";

/** Fewer unread Turns than this are quicker to read than a summary. */
const CATCH_UP_MIN_TURNS = 2;

/** The catch-up offer for the unread range of one Conversation visit. */
export type ConversationCatchUpState = {
  data?: ConversationCatchUp;
  error: boolean;
  pending: boolean;
  request(): void;
  /** Unread Messages in the loaded rows. */
  unreadMessages: UnreadMessageCount;
};

/**
 * `more` is set when the unread range goes past the loaded rows, so the
 * reader has at least `count` unread Messages.
 */
type UnreadMessageCount = { count: number; more: boolean };

/**
 * Count the unread Messages in the loaded rows. It costs no request, so a
 * reader far behind sees a lower bound instead of the exact count.
 */
function countLoadedUnreadMessages(
  events: ConversationDetailReport["events"],
  unread: TranscriptUnreadRange,
  pages: { hasNewerPage: boolean; hasPreviousPage: boolean },
): UnreadMessageCount {
  const first = events[0];
  return {
    count: events.filter(
      (event) =>
        event.seq > unread.afterSeq &&
        event.seq <= unread.throughSeq &&
        event.data.type === "message",
    ).length,
    more:
      pages.hasNewerPage ||
      Boolean(
        pages.hasPreviousPage && first && first.seq > unread.afterSeq + 1,
      ),
  };
}

/**
 * Count the Turns that finished in the unread range. When the range goes past
 * the loaded rows, the reader has at least a page of unread rows.
 */
function hasEnoughUnread(
  events: ConversationDetailReport["events"],
  unread: TranscriptUnreadRange,
  pages: { hasNewerPage: boolean; hasPreviousPage: boolean },
): boolean {
  if (pages.hasNewerPage) return true;
  const first = events[0];
  if (pages.hasPreviousPage && first && first.seq > unread.afterSeq) {
    return true;
  }
  let turns = 0;
  for (const event of events) {
    if (event.seq <= unread.afterSeq || event.seq > unread.throughSeq) continue;
    if (
      event.data.type === "turn_lifecycle" &&
      event.data.state !== "started"
    ) {
      turns += 1;
    }
  }
  return turns >= CATCH_UP_MIN_TURNS;
}

/** Offer a catch-up only when enough is unread. */
export function useConversationCatchUp(input: {
  conversationId: string;
  events?: ConversationDetailReport["events"];
  hasNewerPage: boolean;
  hasPreviousPage: boolean;
  unread?: TranscriptUnreadRange;
}): ConversationCatchUpState | undefined {
  const { unread } = input;
  const mutation = useMutation({
    mutationFn: (range: TranscriptUnreadRange) =>
      post(
        conversationCatchUpSchema,
        `/api/conversations/${encodeURIComponent(input.conversationId)}/catch-up`,
        range,
      ),
  });
  // Once asked, keep the answer even if the loaded rows change.
  const asked = !mutation.isIdle;
  if (
    !unread ||
    (!asked && (!input.events || !hasEnoughUnread(input.events, unread, input)))
  ) {
    return undefined;
  }
  return {
    data: mutation.data,
    error: mutation.isError,
    pending: mutation.isPending,
    request: () => mutation.mutate(unread),
    unreadMessages: countLoadedUnreadMessages(
      input.events ?? [],
      unread,
      input,
    ),
  };
}

/** Only the Conversation page sets it, so nested transcripts offer nothing. */
export const ConversationCatchUpContext = createContext<
  ConversationCatchUpState | undefined
>(undefined);

/** Read the catch-up offer of the current Conversation page. */
export function useConversationCatchUpState() {
  return useContext(ConversationCatchUpContext);
}
