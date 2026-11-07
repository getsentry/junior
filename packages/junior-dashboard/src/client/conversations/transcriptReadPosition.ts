/**
 * Track how far the reader has read a Conversation transcript.
 *
 * Rows from stored events carry `data-transcript-seq`. While the page is
 * visible, the reporter sends the sequence of the last row that has reached
 * the viewport. The server keeps the highest value, so every client of the
 * same user shares one position. A write does not change the detail version,
 * so other clients get it with the next detail change or a reload.
 *
 * The page reads the position once when a Conversation opens. That value
 * places the "New" marker and, by the reader's preference, where the
 * transcript starts. It does not move during the visit, like Slack.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocalStorage } from "@uidotdev/usehooks";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  conversationReadReportSchema,
  type ConversationDetailReport,
  type ConversationEventPage,
  type ConversationFeed,
  type ConversationReadPosition,
} from "@sentry/junior/api/schema";
import { CONVERSATION_START_POSITION_STORAGE_KEY as START_POSITION_STORAGE_KEY } from "../../conversation-open";
import { put } from "../http";
import {
  conversationDetailQueryKey,
  conversationReadScope,
  conversationUnreadMutationKey,
} from "./queries";
import { scrollRootFor } from "./transcriptBottomPinning";

const READ_REPORT_DELAY_MS = 750;
const SEQ_ATTRIBUTE = "data-transcript-seq";
const ROW_SELECTOR = `[${SEQ_ATTRIBUTE}]`;
const SCROLL_KEYS = new Set([
  " ",
  "ArrowDown",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
]);

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
  /** Set when unread events start before the latest page. */
  unreadCursor?: string;
  /** The page around `unreadCursor`, when the fetch brought it. */
  unreadPage?: ConversationEventPage;
};

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
 * Keep the read state from when the reader opened the Conversation. The page
 * is keyed by Conversation, so this runs once for each visit.
 *
 * The read position comes from the first detail, which can be a cached copy.
 * The last unread row comes from the first detail fetched in this visit, so a
 * stale cache cannot hide messages that arrived while the reader was away,
 * and later polls cannot add rows that arrived after open. `unreadCursor`
 * and its page come from that fetch too: a cache from a visit that read to
 * the end has no cursor, even when more than a page arrived after that visit.
 */
export function useReadPositionAtOpen(
  detail: DetailAtOpen | undefined,
  /** The first detail fetched in this visit, not only read from the cache. */
  fetched: DetailAtOpen | undefined,
): ReadPositionAtOpen {
  // Store derived state during render so the first transcript render has it.
  const [opened, setOpened] = useState<{ lastReadSeq?: number }>();
  const [fetchedEnd, setFetchedEnd] = useState<{
    throughSeq?: number;
    unreadCursor?: string;
    unreadPage?: ConversationEventPage;
  }>();
  const read =
    opened ??
    (detail ? { lastReadSeq: detail.readPosition?.lastReadSeq } : undefined);
  if (!opened && read) setOpened(read);
  const end =
    fetchedEnd ??
    (fetched
      ? {
          throughSeq: fetched.events.at(-1)?.seq,
          unreadCursor: fetched.unreadCursor,
          unreadPage: fetched.unreadPage,
        }
      : undefined);
  if (!fetchedEnd && end) setFetchedEnd(end);
  return {
    ...readPositionAtOpen(
      read?.lastReadSeq,
      end ? end.throughSeq : detail?.events.at(-1)?.seq,
    ),
    ...(end?.unreadCursor
      ? { unreadCursor: end.unreadCursor, unreadPage: end.unreadPage }
      : undefined),
  };
}

type DetailAtOpen = {
  events: readonly { seq: number }[];
  readPosition?: ConversationReadPosition;
  unreadCursor?: string;
  unreadPage?: ConversationEventPage;
};

/** Find the rows after the read position, through the last row at open. */
function readPositionAtOpen(
  lastReadSeq: number | undefined,
  throughSeq: number | undefined,
): ReadPositionAtOpen {
  if (lastReadSeq === undefined) return {};
  if (throughSeq === undefined || throughSeq <= lastReadSeq) {
    return { lastReadSeq };
  }
  return { lastReadSeq, unread: { afterSeq: lastReadSeq, throughSeq } };
}

/**
 * Put a stored read position in the cached detail. Polls answer 304 after a
 * read, so the cache must also drop the unread cursor once the reader reaches
 * the latest page, as the server would. Otherwise the next visit in this
 * session opens at rows the reader has already read.
 */
function withReadPosition(
  detail: ConversationDetailReport,
  readPosition: ConversationReadPosition,
): ConversationDetailReport {
  const firstSeq = detail.events[0]?.seq;
  if (
    !detail.unreadCursor ||
    (firstSeq !== undefined && readPosition.lastReadSeq + 1 < firstSeq)
  ) {
    return { ...detail, readPosition };
  }
  const { unreadCursor: _cursor, unreadPage: _page, ...rest } = detail;
  return { ...rest, readPosition };
}

/**
 * Send read positions for one Conversation. A position at or before the one
 * in the cached detail is not sent, because the server already has it. The
 * cached detail keeps the stored value, so the next visit in this session
 * opens at the right place.
 */
export function useMarkConversationRead(conversationId: string) {
  const queryClient = useQueryClient();
  const { mutate } = useMutation({
    scope: conversationReadScope(conversationId),
    mutationFn: (lastReadSeq: number) =>
      put(
        conversationReadReportSchema,
        `/api/conversations/${encodeURIComponent(conversationId)}/read-position`,
        { lastReadSeq },
      ),
    onSuccess: async ({ unreadReply, ...readPosition }) => {
      const detailQueryKey = conversationDetailQueryKey(conversationId);
      const feeds = { queryKey: ["dashboard", "conversations"] };
      // A Mark as read or unread queued after this report owns the flag.
      const clearsUnread =
        !unreadReply &&
        queryClient.isMutating({
          mutationKey: conversationUnreadMutationKey(conversationId),
        }) === 0 &&
        (queryClient.getQueryData<ConversationDetailReport>(detailQueryKey)
          ?.unread ||
          queryClient
            .getQueriesData<ConversationFeed>(feeds)
            .some(([, feed]) =>
              feed?.conversations.some(
                (conversation) =>
                  conversation.conversationId === conversationId &&
                  conversation.unread,
              ),
            ));
      if (clearsUnread) {
        // A poll that started before this read would put the unread flag
        // back. The next poll reads after the write.
        await Promise.all([
          queryClient.cancelQueries(feeds),
          queryClient.cancelQueries({ exact: true, queryKey: detailQueryKey }),
        ]);
        queryClient.setQueriesData<ConversationFeed>(feeds, (feed) =>
          feed
            ? {
                ...feed,
                conversations: feed.conversations.map((conversation) =>
                  conversation.conversationId === conversationId
                    ? { ...conversation, unread: undefined }
                    : conversation,
                ),
              }
            : feed,
        );
      }
      queryClient.setQueryData<ConversationDetailReport>(
        detailQueryKey,
        (detail) =>
          detail && {
            ...withReadPosition(detail, readPosition),
            ...(clearsUnread ? { unread: undefined } : undefined),
          },
      );
    },
  });
  return useCallback(
    (lastReadSeq: number) => {
      const stored = queryClient.getQueryData<ConversationDetailReport>(
        conversationDetailQueryKey(conversationId),
      )?.readPosition?.lastReadSeq;
      if (stored !== undefined && lastReadSeq <= stored) return;
      // A row seen before Mark as unread must not read the conversation again.
      if (
        queryClient.isMutating({
          mutationKey: conversationUnreadMutationKey(conversationId),
        }) > 0
      ) {
        return;
      }
      mutate(lastReadSeq);
    },
    [conversationId, mutate, queryClient],
  );
}

/**
 * Report the last transcript row that the reader saw.
 *
 * An IntersectionObserver keeps the set of rows in the viewport, so a scroll
 * does not measure rows. Reports send the highest seq in that set. They wait
 * a short time and only move forward. A hidden or paused page does not
 * report. Leaving the page or hiding it sends the pending row at once, so a
 * quick exit keeps progress.
 *
 * Opening a Conversation is not reading it, so nothing reports until the
 * reader acts in this visit: a wheel, touch, pointer, or key input in the
 * transcript, or `engaged` from the composer. A scroll that the page makes,
 * such as to the "New" marker or to follow new rows, does not count. After
 * the first input, the rows in view and the rows that come into view report.
 */
export function useTranscriptReadReporter(input: {
  content: HTMLElement | null;
  /** The stored position. Rows after it report. */
  lastReadSeq?: number;
  onRead?: (seq: number) => void;
  /** The reader acted outside the transcript, such as in the composer. */
  engaged?: boolean;
  /**
   * Stop reporting while the rows are not in reading order, such as search
   * results. This is read when a report is scheduled, so the render that
   * changes the rows also stops their report.
   */
  paused?: boolean;
}): void {
  const onReadRef = useRef(input.onRead);
  onReadRef.current = input.onRead;
  const pausedRef = useRef(input.paused);
  pausedRef.current = input.paused;
  const reportedRef = useRef(input.lastReadSeq ?? -1);
  // Once per visit: the page is keyed by Conversation.
  const engagedRef = useRef(false);
  const engageRef = useRef<() => void>(undefined);
  const engagedInputRef = useRef(input.engaged);
  engagedInputRef.current = input.engaged;

  // Mark as unread moves the stored position back. A cached copy at open can
  // also be ahead of the fetched one. Rows after it must report again.
  useEffect(() => {
    if (
      input.lastReadSeq !== undefined &&
      input.lastReadSeq < reportedRef.current
    ) {
      reportedRef.current = input.lastReadSeq;
    }
  }, [input.lastReadSeq]);
  const enabled = Boolean(input.onRead);

  useEffect(() => {
    if (input.engaged) engageRef.current?.();
  }, [input.engaged]);

  useEffect(() => {
    const content = input.content;
    const root = scrollRootFor(content);
    if (!enabled || !content || !root) return;
    if (typeof IntersectionObserver === "undefined") return;

    const visibleRows = new Set<HTMLElement>();
    let timer: number | undefined;
    let seenSeq: number | null = null;
    const send = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      const seq = seenSeq;
      seenSeq = null;
      if (seq === null || seq <= reportedRef.current) return;
      reportedRef.current = seq;
      onReadRef.current?.(seq);
    };
    const schedule = () => {
      if (
        !engagedRef.current ||
        pausedRef.current ||
        document.visibilityState !== "visible"
      ) {
        return;
      }
      // Read the seq now: an activity group row moves its seq as it grows.
      for (const row of visibleRows) {
        const seq = Number(row.dataset.transcriptSeq);
        if (Number.isSafeInteger(seq)) seenSeq = Math.max(seenSeq ?? -1, seq);
      }
      if (seenSeq === null) return;
      timer ??= window.setTimeout(send, READ_REPORT_DELAY_MS);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") schedule();
      else send();
    };

    const intersections = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const row = entry.target as HTMLElement;
          if (entry.isIntersecting && row.isConnected) visibleRows.add(row);
          else visibleRows.delete(row);
        }
        schedule();
      },
      { root: root === window ? null : (root as HTMLElement) },
    );
    const rowsIn = (node: Node): HTMLElement[] => {
      if (!(node instanceof HTMLElement)) return [];
      const rows = [...node.querySelectorAll<HTMLElement>(ROW_SELECTOR)];
      return node.matches(ROW_SELECTOR) ? [node, ...rows] : rows;
    };
    const observeRows = (node: Node) => {
      for (const row of rowsIn(node)) intersections.observe(row);
    };
    const forgetRows = (node: Node) => {
      for (const row of rowsIn(node)) {
        intersections.unobserve(row);
        visibleRows.delete(row);
      }
    };
    // Rows mount and unmount as history loads and replies arrive. An
    // activity group row keeps its node and raises its seq as tools arrive.
    const mutations = new MutationObserver((records) => {
      let seqChanged = false;
      for (const record of records) {
        record.addedNodes.forEach(observeRows);
        record.removedNodes.forEach(forgetRows);
        if (record.type === "attributes") {
          const row = record.target as HTMLElement;
          intersections.observe(row);
          seqChanged ||= visibleRows.has(row);
        }
      }
      if (seqChanged) schedule();
    });
    mutations.observe(content, {
      attributeFilter: [SEQ_ATTRIBUTE],
      childList: true,
      subtree: true,
    });
    observeRows(content);
    // Rows already in view report on the first input, without a scroll.
    const engage = () => {
      if (engagedRef.current) return;
      engagedRef.current = true;
      schedule();
    };
    engageRef.current = engage;
    // Input events, not `scroll`: the page scrolls on its own too.
    const inputTarget = root === window ? content : (root as HTMLElement);
    const inputEvents = ["wheel", "touchstart", "pointerdown", "keydown"];
    for (const type of inputEvents) {
      inputTarget.addEventListener(type, engage, { passive: true });
    }
    // Scroll keys go to the page when nothing has focus.
    const onPageKey = (event: KeyboardEvent) => {
      if (
        document.activeElement === document.body &&
        SCROLL_KEYS.has(event.key)
      ) {
        engage();
      }
    };
    document.addEventListener("keydown", onPageKey);
    if (engagedInputRef.current) engage();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      send();
      engageRef.current = undefined;
      for (const type of inputEvents) {
        inputTarget.removeEventListener(type, engage);
      }
      document.removeEventListener("keydown", onPageKey);
      intersections.disconnect();
      mutations.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled, input.content]);
}
