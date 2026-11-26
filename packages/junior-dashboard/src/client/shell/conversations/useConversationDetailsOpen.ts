import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import {
  CONVERSATION_REVIEW_OPEN,
  CONVERSATION_REVIEW_PARAM,
} from "../../conversations/conversationRoutes";
import {
  saveDetailsOpen,
  useDetailsStartOpen,
} from "../../conversations/conversationSidebarLayout";

/**
 * Whether a Conversation page shows its details, and the reader's choice to
 * open or close them. The choice is saved for the next Conversation.
 */
export function useConversationDetailsOpen(eventOpen: boolean) {
  const [searchParams, setSearchParams] = useSearchParams();
  // Event details and turn context show over Conversation details. Closing
  // them shows details again when details are open. A linked event starts
  // with details closed, so closing it does not open a panel nobody chose.
  const [detailsChoice, setDetailsChoice] = useState<boolean | undefined>(() =>
    eventOpen ? false : undefined,
  );
  // A sidebar review chip links here with the review param. It opens
  // details at its Inbox items, even below the width where details open alone.
  const reviewOpen =
    searchParams.get(CONVERSATION_REVIEW_PARAM) === CONVERSATION_REVIEW_OPEN;
  useEffect(() => {
    if (reviewOpen) setDetailsChoice(true);
  }, [reviewOpen]);
  const detailsDefault = useDetailsStartOpen();
  const detailsOpen = detailsChoice ?? (reviewOpen || detailsDefault);
  const openDetails = useCallback(() => {
    setDetailsChoice(true);
    saveDetailsOpen(true);
  }, []);
  const closeDetails = useCallback(() => {
    setDetailsChoice(false);
    saveDetailsOpen(false);
    setSearchParams(
      (current) => {
        if (!current.has(CONVERSATION_REVIEW_PARAM)) return current;
        const next = new URLSearchParams(current);
        next.delete(CONVERSATION_REVIEW_PARAM);
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);
  return {
    closeDetails,
    // False while details follow the screen width.
    closedByReader: detailsChoice === false,
    detailsOpen,
    openDetails,
    reviewOpen,
  };
}
