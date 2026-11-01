/**
 * Track how far the reader has read a Conversation transcript.
 *
 * Rows from stored events carry `data-transcript-seq`. While the page is
 * visible, the reporter sends the sequence of the last row that has reached
 * the viewport. The server keeps the highest value, so every client of the
 * same user shares one position. Detail polls bring it back to other clients.
 *
 * The page reads the position once when a Conversation opens. That value
 * places the "New" marker and, by the reader's preference, where the
 * transcript starts. It does not move during the visit, like Slack.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocalStorage } from "@uidotdev/usehooks";
import { useEffect, useRef, useState } from "react";

import {
  conversationReadPositionSchema,
  type ConversationDetailReport,
  type ConversationReadPosition,
} from "@sentry/junior/api/schema";
import { put } from "../http";
import { conversationDetailQueryKey } from "./queries";
import { scrollRootFor, viewportBounds } from "./transcriptBottomPinning";

const READ_REPORT_DELAY_MS = 750;
const START_POSITION_STORAGE_KEY = "junior:conversation:start-position";

/** Where a Conversation opens: at the first unread row or at the latest. */
export type ConversationStartPosition = "unread" | "latest";

/**
 * Event sequences that were unread when the Conversation opened. Rows that
 * arrive later are not in it, so a reader who follows new replies gets no
 * marker for them.
 */
export type TranscriptUnreadRange = { afterSeq: number; throughSeq: number };

/** The read state when the Conversation opened. */
export type ReadPositionAtOpen = {
  lastReadSeq?: number;
  unread?: TranscriptUnreadRange;
};

type VerticalBounds = { bottom: number; top: number };

/** Edit the browser-only preference for where Conversations open. */
export function useConversationStartPosition() {
  return useLocalStorage<ConversationStartPosition>(
    START_POSITION_STORAGE_KEY,
    "unread",
  );
}

/**
 * Read the start preference without subscribing. A Conversation reads it once
 * when it opens, and this works where `useLocalStorage` cannot, such as
 * server rendering.
 */
export function readConversationStartPosition(): ConversationStartPosition {
  if (typeof window === "undefined") return "unread";
  try {
    const stored = window.localStorage.getItem(START_POSITION_STORAGE_KEY);
    return stored && JSON.parse(stored) === "latest" ? "latest" : "unread";
  } catch {
    return "unread";
  }
}

/**
 * Keep the read state from the first loaded detail. The Conversation page is
 * keyed by Conversation, so this is the state when the reader opened it.
 */
export function useReadPositionAtOpen(
  detail:
    | {
        events: readonly { seq: number }[];
        readPosition?: ConversationReadPosition;
      }
    | undefined,
): ReadPositionAtOpen {
  const [opened, setOpened] = useState<ReadPositionAtOpen>();
  if (opened) return opened;
  if (!detail) return {};
  const next = readPositionAtOpen(detail);
  // Store derived state during render so the first transcript render has it.
  setOpened(next);
  return next;
}

/** Find the rows that were unread in the first loaded detail. */
export function readPositionAtOpen(detail: {
  events: readonly { seq: number }[];
  readPosition?: ConversationReadPosition;
}): ReadPositionAtOpen {
  const lastReadSeq = detail.readPosition?.lastReadSeq;
  const throughSeq = detail.events.at(-1)?.seq;
  if (lastReadSeq === undefined) return {};
  if (throughSeq === undefined || throughSeq <= lastReadSeq) {
    return { lastReadSeq };
  }
  return { lastReadSeq, unread: { afterSeq: lastReadSeq, throughSeq } };
}

/**
 * Send read positions for one Conversation. The cached detail keeps the
 * stored value, so the next visit in this session opens at the right place.
 */
export function useMarkConversationRead(conversationId: string) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (lastReadSeq: number) =>
      put(
        conversationReadPositionSchema,
        `/api/conversations/${encodeURIComponent(conversationId)}/read-position`,
        { lastReadSeq },
      ),
    onSuccess: (readPosition) => {
      queryClient.setQueryData<ConversationDetailReport>(
        conversationDetailQueryKey(conversationId),
        (detail) => (detail ? { ...detail, readPosition } : detail),
      );
    },
  });
  return mutation.mutate;
}

/**
 * Find the last row that has reached the viewport, in rows that are in
 * document order.
 */
export function lastSeenRowIndex(
  count: number,
  rowAt: (index: number) => VerticalBounds,
  viewport: VerticalBounds,
): number | null {
  let low = 0;
  let high = count;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (rowAt(middle).top < viewport.bottom) low = middle + 1;
    else high = middle;
  }
  return low === 0 ? null : low - 1;
}

/**
 * Report the last transcript row that the reader saw.
 *
 * Reports wait a short time after scrolling and layout changes, and only
 * move forward. A hidden page does not report.
 */
export function useTranscriptReadReporter(input: {
  content: HTMLElement | null;
  /** The stored position when the Conversation opened. */
  lastReadSeq?: number;
  onRead?: (seq: number) => void;
}): void {
  const onReadRef = useRef(input.onRead);
  onReadRef.current = input.onRead;
  const reportedRef = useRef(input.lastReadSeq ?? -1);
  const enabled = Boolean(input.onRead);

  useEffect(() => {
    const content = input.content;
    const root = scrollRootFor(content);
    if (!enabled || !content || !root) return;

    let timer: number | undefined;
    const report = () => {
      timer = undefined;
      if (document.visibilityState !== "visible") return;
      const seq = lastSeenTranscriptSeq(content, viewportBounds(root));
      if (seq === null || seq <= reportedRef.current) return;
      reportedRef.current = seq;
      onReadRef.current?.(seq);
    };
    const schedule = () => {
      timer ??= window.setTimeout(report, READ_REPORT_DELAY_MS);
    };

    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(schedule);
    observer?.observe(content);
    root.addEventListener("scroll", schedule, { passive: true });
    document.addEventListener("visibilitychange", schedule);
    schedule();
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      observer?.disconnect();
      root.removeEventListener("scroll", schedule);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [enabled, input.content]);
}

function lastSeenTranscriptSeq(
  content: HTMLElement,
  viewport: VerticalBounds,
): number | null {
  const rows = content.querySelectorAll<HTMLElement>("[data-transcript-seq]");
  const index = lastSeenRowIndex(
    rows.length,
    (row) => rows[row]!.getBoundingClientRect(),
    viewport,
  );
  if (index === null) return null;
  const seq = Number(rows[index]!.dataset.transcriptSeq);
  return Number.isSafeInteger(seq) ? seq : null;
}
