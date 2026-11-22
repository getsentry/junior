import { useEffect, useRef } from "react";
import type { ConversationReportEvent } from "@sentry/junior/api/schema";

import { messageEventSeq } from "./conversationRoutes";
import { unheldLinkStart } from "./transcriptAroundHistory";

const HIGHLIGHT_MS = 2_000;

/**
 * Show the row of a linked Message or event seq once and mark it for a
 * moment. Returns the seq while the loaded events hold it, so the
 * transcript keeps that row mounted. The page loads the page around it.
 *
 * An event seq shows the row that holds the event: the first row at or after
 * it, since a row carries the seq of its last event. An event after the last
 * row, such as the end of a Turn, shows the last row before it.
 */
export function useMessageLinkJump(input: {
  content: HTMLElement | null;
  events: readonly ConversationReportEvent[] | undefined;
  link: { event: number } | { message: string } | undefined;
  /** Center the row and hold that place while rows above it resize. */
  showRow: (row: Element, options?: { instant?: boolean }) => boolean;
}): number | undefined {
  const { content, events, link, showRow } = input;
  const shownRef = useRef<string>(undefined);
  const linkKey =
    link === undefined
      ? undefined
      : "message" in link
        ? `message:${link.message}`
        : `event:${link.event}`;
  const seq =
    link === undefined
      ? undefined
      : "message" in link
        ? messageEventSeq(events, link.message)
        : unheldLinkStart(events, link)
          ? undefined
          : link.event;
  const nearestBefore = link !== undefined && "event" in link;
  useEffect(() => {
    if (!content || seq === undefined || shownRef.current === linkKey) {
      return;
    }
    // A row carries the seq of its last event. A reply that ends a Turn
    // with Tasks carries a Task's seq, so match the first row that reaches
    // the seq, like the row the transcript keeps mounted for it.
    const rows = Array.from(content.querySelectorAll("[data-transcript-seq]"));
    const rowSeq = (row: Element) =>
      Number(row.getAttribute("data-transcript-seq"));
    const row =
      rows.find((candidate) => rowSeq(candidate) >= seq) ??
      (nearestBefore
        ? rows.filter((candidate) => rowSeq(candidate) < seq).at(-1)
        : undefined);
    if (!row) return;
    shownRef.current = linkKey;
    // A smooth scroll stops when rows that mount on the way resize.
    showRow(row, { instant: true });
    markTranscriptRow(row);
  }, [content, events, linkKey, nearestBefore, seq, showRow]);
  return seq;
}

/** Mark a transcript row for a moment, so the reader sees where a jump went. */
export function markTranscriptRow(row: Element) {
  row.setAttribute("data-highlighted", "");
  window.setTimeout(
    () => row.removeAttribute("data-highlighted"),
    HIGHLIGHT_MS,
  );
}
