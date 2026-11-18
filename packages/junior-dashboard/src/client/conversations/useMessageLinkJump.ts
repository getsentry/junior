import { useEffect, useRef } from "react";
import type { ConversationReportEvent } from "@sentry/junior/api/schema";

import { messageEventSeq } from "./conversationRoutes";

const HIGHLIGHT_MS = 2_000;

/**
 * Show the row of a linked Message once and mark it for a moment.
 * Returns the seq of its event while the loaded events hold it, so the
 * transcript keeps that row mounted. The page loads the page around it.
 */
export function useMessageLinkJump(input: {
  content: HTMLElement | null;
  events: readonly ConversationReportEvent[] | undefined;
  messageId: string | undefined;
  /** Center the row and hold that place while rows above it resize. */
  showRow: (
    row: Element,
    options: { arrived: boolean; instant?: boolean },
  ) => boolean;
}): number | undefined {
  const { content, events, messageId, showRow } = input;
  const shownRef = useRef<string>(undefined);
  const seq =
    messageId === undefined ? undefined : messageEventSeq(events, messageId);
  useEffect(() => {
    if (!content || seq === undefined || shownRef.current === messageId) {
      return;
    }
    const row = content.querySelector(`[data-transcript-seq="${seq}"]`);
    if (!row) return;
    shownRef.current = messageId;
    // A smooth scroll stops when rows that mount on the way resize.
    showRow(row, { arrived: false, instant: true });
    row.setAttribute("data-highlighted", "");
    window.setTimeout(
      () => row.removeAttribute("data-highlighted"),
      HIGHLIGHT_MS,
    );
  }, [content, events, messageId, seq, showRow]);
  return seq;
}
