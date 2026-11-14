import {
  createContext,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefCallback,
  type RefObject,
} from "react";

import type { ConversationReportEvent } from "@sentry/junior/api/schema";

import type { ConversationTranscript } from "../types";
import type { TranscriptViewMode } from "./transcriptRenderModel";
import {
  captureScrollAnchor,
  scrollAnchorShift,
  type ScrollAnchor,
} from "./transcriptScrollAnchor";

const BOTTOM_PROXIMITY_PX = 96;
const HISTORY_PAGE_PROXIMITY_PX = 600;
const USER_SCROLL_DELTA_PX = 2;
// Leave a little earlier context above the "New" marker.
const UNREAD_START_OFFSET_PX = 48;

type ScrollRoot = HTMLElement | Window;
type PositionMeasureSource = "measure" | "scroll";

export type TranscriptFollowIntent = "follow" | "pause" | "preserve";

export type ScrollSnapshot = {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
};

type BottomPinResult = {
  anchorRef: RefObject<HTMLDivElement | null>;
  contentElement: HTMLDivElement | null;
  contentRef: RefCallback<HTMLDivElement>;
  hasPendingUpdate: boolean;
  jumpToBottom: () => void;
  /**
   * Show a mounted row. A row that the reader asks for moves to the middle
   * of the viewport. A row that `arrived` by itself moves only into view,
   * and only while the reader follows the latest. Returns false when the
   * row does not show.
   */
  showRow: (row: Element, options: { arrived: boolean }) => boolean;
  /** The `data-scroll-anchor` key of the row that holds the reader's place. */
  scrollAnchorKey: () => string | undefined;
  showJumpToLatest: boolean;
};

const useBrowserLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Detect proximity with slack so fractional pixels and mobile chrome do not break follow mode. */
export function isNearScrollBottom(
  snapshot: ScrollSnapshot,
  thresholdPx = BOTTOM_PROXIMITY_PX,
): boolean {
  const remaining =
    snapshot.scrollHeight - snapshot.scrollTop - snapshot.clientHeight;
  return remaining <= thresholdPx;
}

/** Build a version that changes only when a visible Junior message appears. */
export function transcriptJuniorMessageVersion(
  conversation: ConversationTranscript | undefined,
): string {
  if (!conversation) return "empty";
  for (let index = conversation.events.length - 1; index >= 0; index -= 1) {
    const event = conversation.events[index]!;
    const data = event.data;
    if (data.type === "message" && data.role === "assistant") {
      return [
        event.seq,
        event.createdAt,
        data.messageId,
        data.redacted ? "redacted" : (data.text?.length ?? 0),
      ].join(":");
    }
    if (data.type === "assistant_message" && data.parts.length > 0) {
      const lastPart = data.parts.at(-1);
      return [
        event.seq,
        event.createdAt,
        data.parts.length,
        lastPart?.redacted ? "redacted" : (lastPart?.text?.length ?? 0),
      ].join(":");
    }
  }
  return "empty";
}

/** Build a compact visible-tail key so metadata-only polls do not look new. */
export function transcriptBottomVersion(
  conversation: ConversationTranscript | undefined,
  view: TranscriptViewMode = "rich",
): string {
  if (!conversation) return "empty";

  // Only the visible tail matters. Earlier pages must not count as new activity.
  // The event log shows all events; the transcript omits some metadata events.
  let last: ConversationReportEvent | undefined;
  for (let index = conversation.events.length - 1; index >= 0; index -= 1) {
    const event = conversation.events[index]!;
    if (view === "rich" && !changesVisibleTranscript(event)) continue;
    last = event;
    break;
  }

  return [
    conversation.conversationId,
    conversation.status,
    last?.seq ?? "",
    last?.createdAt ?? "",
    eventTailVersion(last),
  ].join("|");
}

function changesVisibleTranscript(event: ConversationReportEvent): boolean {
  const data = event.data;
  if (data.type === "turn_lifecycle") return data.state === "failed";
  return (
    data.type === "message" ||
    (data.type === "assistant_message" && data.parts.length > 0) ||
    data.type === "tool_calls" ||
    data.type === "subagent" ||
    data.type === "structured_event" ||
    data.type === "attachments_delivered" ||
    data.type === "compaction"
  );
}

function eventTailVersion(event: ConversationReportEvent | undefined): string {
  if (!event) return "";
  const data = event.data;
  switch (data.type) {
    case "message":
      return [
        data.type,
        data.role,
        data.messageId,
        data.redacted ? "redacted" : (data.text?.length ?? 0),
        data.eventType ?? "",
      ].join(":");
    case "assistant_message": {
      const parts = data.parts;
      const lastPart = parts.at(-1);
      return [
        data.type,
        parts.length,
        lastPart?.redacted ? "redacted" : (lastPart?.text?.length ?? 0),
      ].join(":");
    }
    case "tool_calls": {
      const call = data.calls.at(-1);
      return [
        data.type,
        data.calls.length,
        call?.toolCallId ?? "",
        call?.name ?? "",
        call?.status ?? "",
        call?.output === undefined ? "" : "output",
      ].join(":");
    }
    case "subagent":
      return [
        data.type,
        data.childConversationId,
        data.status,
        data.subagentKind,
        data.parentToolCallId ?? "",
      ].join(":");
    case "turn_lifecycle":
      return [
        data.type,
        data.turnId,
        data.state,
        "failureCode" in data ? data.failureCode : "",
        "failureReason" in data ? (data.failureReason ?? "") : "",
      ].join(":");
    case "structured_event":
      return [
        data.type,
        data.namespace,
        data.name,
        data.version,
        data.presentation.title,
        data.presentation.preview?.length ?? 0,
      ].join(":");
    case "message_handled":
      return [data.type, data.messageId].join(":");
    case "attachments_delivered":
      return [
        data.type,
        data.attachments.length,
        ...data.attachments.map(
          (attachment) =>
            `${attachment.id}:${attachment.filename}:${attachment.bytes}`,
        ),
      ].join(":");
    case "compaction":
      return [data.type, data.summary?.length ?? 0, event.createdAt].join(":");
    case "guardian_action_reviewed":
      return [data.type, data.turnId, data.toolCallId, data.decision].join(":");
    case "turn_context":
      return [
        data.type,
        data.turnId,
        data.pluginName,
        data.kind,
        data.version,
      ].join(":");
    default:
      return `${(data as { type?: string }).type ?? "unknown"}:${event.seq}`;
  }
}

/** Require both live mode and reader intent before moving the viewport. */
export function shouldAutoPinTranscriptBottom(input: {
  enabled: boolean;
  following: boolean;
}): boolean {
  return input.enabled && input.following;
}

/** Keep a terminal pin pending until the deferred Junior reply arrives. */
export function terminalReplyPinState(input: {
  enabled: boolean;
  following: boolean;
  juniorMessageChanged: boolean;
  pending: boolean;
  wasEnabled: boolean;
}): { pending: boolean; pin: boolean } {
  if (input.enabled) return { pending: false, pin: false };
  const pending =
    input.pending || (input.wasEnabled && !input.enabled && input.following);
  if (pending && input.juniorMessageChanged) {
    return { pending: false, pin: true };
  }
  return { pending, pin: false };
}

/**
 * Show the jump control only when the reader left the bottom and a newer tail
 * arrived, when the transcript opened at unread rows, or when it does not end
 * at the latest event. Staying pinned, or intentionally following, must not
 * flash it.
 */
export function shouldShowJumpToLatest(input: {
  enabled: boolean;
  endsAtLatest?: boolean | undefined;
  following: boolean;
  hasPendingUpdate: boolean;
  openedAtUnread?: boolean;
}): boolean {
  return (
    !input.following &&
    (input.endsAtLatest === false ||
      Boolean(input.openedAtUnread) ||
      (input.enabled && input.hasPendingUpdate))
  );
}

/** Resolve scroll intent with user upward movement taking precedence over bottom slack. */
export function transcriptFollowIntent(input: {
  previousScrollTop: number | null;
  snapshot: ScrollSnapshot;
  source: PositionMeasureSource;
}): TranscriptFollowIntent {
  if (
    input.source === "scroll" &&
    input.previousScrollTop != null &&
    input.snapshot.scrollTop < input.previousScrollTop - USER_SCROLL_DELTA_PX
  ) {
    return "pause";
  }

  if (input.source === "scroll" && isNearScrollBottom(input.snapshot)) {
    return "follow";
  }
  return "preserve";
}

/**
 * Decide how a scroll event interacts with an open programmatic pin settle.
 *
 * Pin settle noise and layout clamps must not pause follow. Only a real leave
 * from the bottom should win over the settle window.
 */
export function programmaticSettleScrollAction(input: {
  intent: TranscriptFollowIntent;
  snapshot: ScrollSnapshot;
}): "ignore" | "pause" {
  // Layout clamps can drop scrollTop while the reader is still at the bottom.
  // Treat only a leave-bottom pause as intentional scroll-away.
  if (input.intent === "pause" && !isNearScrollBottom(input.snapshot)) {
    return "pause";
  }
  return "ignore";
}

/** Keep live transcript updates visually pinned only while the reader intends to follow them. */
export function usePinnedTranscriptBottom(input: {
  conversationId?: string | undefined;
  enabled: boolean;
  /**
   * False while newer pages are not loaded. The end of the transcript is
   * then not the latest event, so the reader cannot follow it, and a page
   * that loads below them does not pull them down.
   */
  endsAtLatest?: boolean;
  historyVersion: string;
  juniorMessageVersion: string;
  pinRequestVersion?: number | undefined;
  /** Open where a link shows its row, not at the latest message. */
  startAtLink?: boolean | undefined;
  /** Open at the "New" marker when the transcript has one. */
  startAtUnread?: boolean | undefined;
  view: TranscriptViewMode;
  versions: Record<TranscriptViewMode, string>;
}): BottomPinResult {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const contentElementRef = useRef<HTMLDivElement | null>(null);
  const enabledRef = useRef(input.enabled);
  const endsAtLatestRef = useRef(true);
  endsAtLatestRef.current = input.endsAtLatest ?? true;
  const followingRef = useRef(false);
  const initializedRef = useRef(false);
  // The Conversation and start that the transcript opened with. A link at
  // open that fails becomes a normal start, so the transcript opens again.
  const startedRef = useRef<string | null>(null);
  const previousScrollTopRef = useRef<number | null>(null);
  // The scroll position that the last restore or open at the marker set.
  // Its scroll event is not a reader scroll, so it must not change follow
  // intent or the recorded place. Rows can change size before that event,
  // and the restore after them needs the place from before.
  const restoredScrollTopRef = useRef<number | null>(null);
  const scrollAnchorRef = useRef<ScrollAnchor | null>(null);
  const pinRequestVersionRef = useRef(input.pinRequestVersion ?? 0);
  const juniorMessageVersionRef = useRef(input.juniorMessageVersion);
  const terminalEnabledRef = useRef(input.enabled);
  const terminalPinPendingRef = useRef(false);
  const versionsRef = useRef(input.versions);
  const programmaticScrollGenerationRef = useRef(0);
  const [following, setFollowing] = useState(false);
  const [hasPendingUpdate, setHasPendingUpdate] = useState(false);
  const [openedAtUnread, setOpenedAtUnread] = useState(false);
  const [contentElement, setContentElement] = useState<HTMLDivElement | null>(
    null,
  );

  const contentRef = useCallback((node: HTMLDivElement | null) => {
    contentElementRef.current = node;
    setContentElement(node);
  }, []);

  useEffect(() => {
    enabledRef.current = input.enabled;
    if (!input.enabled) setHasPendingUpdate(false);
  }, [input.enabled]);

  // The transcript opened at the latest message, but the reader prefers the
  // "New" marker. The marker can appear when a fetch replaces a cached detail.
  const awaitingUnreadMarkerRef = useRef(false);
  const setFollowingIntent = useCallback((value: boolean) => {
    followingRef.current = value;
    setFollowing(value);
    if (value) setOpenedAtUnread(false);
    else awaitingUnreadMarkerRef.current = false;
  }, []);

  const rememberPlace = useCallback(() => {
    const content = contentElementRef.current;
    const root = scrollRootFor(content);
    if (!content || !root) return;
    scrollAnchorRef.current = captureScrollAnchor(
      content,
      viewportBounds(root),
    );
  }, []);

  // Move by the distance the anchor row moved, so content that grows or
  // shrinks above the reader does not move what they are reading.
  const restorePlace = useCallback(() => {
    const content = contentElementRef.current;
    const root = scrollRootFor(content);
    const anchor = scrollAnchorRef.current;
    if (!content || !root) return;
    const shift = anchor
      ? scrollAnchorShift(content, viewportBounds(root), anchor)
      : null;
    if (shift !== null && Math.abs(shift) >= 1) {
      const scrollTop = scrollSnapshot(root).scrollTop + shift;
      setScrollTop(root, scrollTop);
      const restored = scrollSnapshot(root).scrollTop;
      previousScrollTopRef.current = restored;
      restoredScrollTopRef.current = restored;
    }
    rememberPlace();
  }, [rememberPlace]);

  const leaveBottom = useCallback(() => {
    if (!followingRef.current) return;
    const root = scrollRootFor(contentElementRef.current);
    // Content that fits the viewport has nothing above to read.
    if (!root || scrollSnapshot(root).scrollTop <= 0) return;
    programmaticScrollGenerationRef.current = 0;
    setFollowingIntent(false);
  }, [setFollowingIntent]);

  const measurePosition = useCallback(
    (source: PositionMeasureSource) => {
      const root = scrollRootFor(contentElementRef.current);
      if (!root) return;

      const snapshot = scrollSnapshot(root);
      const previousScrollTop = previousScrollTopRef.current;
      previousScrollTopRef.current = snapshot.scrollTop;

      if (source === "scroll") {
        const restored = restoredScrollTopRef.current;
        restoredScrollTopRef.current = null;
        // A restore near the bottom must not turn follow mode back on.
        if (restored !== null && Math.abs(snapshot.scrollTop - restored) < 1) {
          return;
        }
        rememberPlace();
      }

      const intent = transcriptFollowIntent({
        previousScrollTop,
        snapshot,
        source,
      });

      // While a pin settle is open, ignore noise from our own bottom scroll and
      // layout clamps, but still honor a real leave from the bottom.
      if (source === "scroll" && programmaticScrollGenerationRef.current > 0) {
        if (programmaticSettleScrollAction({ intent, snapshot }) === "pause") {
          programmaticScrollGenerationRef.current = 0;
          setFollowingIntent(false);
        }
        return;
      }

      if (intent === "follow") {
        if (!endsAtLatestRef.current) return;
        setFollowingIntent(true);
        setHasPendingUpdate(false);
        return;
      }

      if (intent === "pause") {
        setFollowingIntent(false);
      }
    },
    [rememberPlace, setFollowingIntent],
  );

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior) => {
      const root = scrollRootFor(contentElementRef.current);
      if (!root) return;

      // Only suppress pin-settle noise while still following. After the reader
      // leaves the bottom, do not open a window that can ignore their scroll.
      const suppressSettleNoise = followingRef.current;
      const generation = suppressSettleNoise
        ? ++programmaticScrollGenerationRef.current
        : 0;
      setScrollTop(root, scrollSnapshot(root).scrollHeight, behavior);

      const settleProgrammaticScroll = () => {
        if (
          suppressSettleNoise &&
          programmaticScrollGenerationRef.current !== generation
        ) {
          return;
        }
        if (suppressSettleNoise) programmaticScrollGenerationRef.current = 0;
        const settled = scrollSnapshot(root);
        previousScrollTopRef.current = settled.scrollTop;
        if (
          enabledRef.current &&
          followingRef.current &&
          isNearScrollBottom(settled)
        ) {
          setFollowingIntent(true);
          setHasPendingUpdate(false);
        }
      };

      if (behavior === "smooth") {
        window.setTimeout(settleProgrammaticScroll, 400);
        return;
      }

      // Wait two frames so the browser can emit the scroll event first.
      requestAnimationFrame(() => {
        requestAnimationFrame(settleProgrammaticScroll);
      });
    },
    [setFollowingIntent],
  );

  const showRow = useCallback(
    (row: Element, options: { arrived: boolean }): boolean => {
      const root = scrollRootFor(contentElementRef.current);
      if (!root) return false;
      // A reader who scrolled away reads something else. Do not move it.
      if (options.arrived && !followingRef.current) return false;
      const bounds = viewportBounds(root);
      const rect = row.getBoundingClientRect();
      const offset = options.arrived
        ? Math.max(0, rect.bottom - bounds.bottom)
        : rect.top -
          bounds.top -
          (bounds.bottom - bounds.top - rect.height) / 2;
      if (Math.abs(offset) < 1) return true;
      // The reader goes to the row, so the latest must not pull them back.
      if (offset < 0) leaveBottom();
      const behavior = preferredExplicitScrollBehavior();
      setScrollTop(
        root,
        Math.max(0, scrollSnapshot(root).scrollTop + offset),
        behavior,
      );
      // A layout change must not restore the place that the reader left.
      // A smooth scroll remembers each new place on its scroll events.
      if (behavior === "smooth") {
        scrollAnchorRef.current = null;
        return true;
      }
      const snapshot = scrollSnapshot(root);
      previousScrollTopRef.current = snapshot.scrollTop;
      restoredScrollTopRef.current = snapshot.scrollTop;
      rememberPlace();
      return true;
    },
    [leaveBottom, rememberPlace],
  );

  /** Scroll to the "New" marker, if the transcript has one. */
  const openAtUnreadMarker = useCallback((): boolean => {
    const content = contentElementRef.current;
    const root = scrollRootFor(content);
    const marker = content?.querySelector("[data-transcript-unread-marker]");
    if (!root || !marker) return false;
    awaitingUnreadMarkerRef.current = false;
    const offset =
      marker.getBoundingClientRect().top - viewportBounds(root).top;
    setScrollTop(
      root,
      Math.max(
        0,
        scrollSnapshot(root).scrollTop + offset - UNREAD_START_OFFSET_PX,
      ),
    );
    const snapshot = scrollSnapshot(root);
    previousScrollTopRef.current = snapshot.scrollTop;
    restoredScrollTopRef.current = snapshot.scrollTop;
    // Unread rows that fit above the bottom leave the reader at the latest.
    const atBottom = endsAtLatestRef.current && isNearScrollBottom(snapshot);
    setFollowingIntent(atBottom);
    setOpenedAtUnread(!atBottom);
    rememberPlace();
    return true;
  }, [rememberPlace, setFollowingIntent]);

  useBrowserLayoutEffect(() => {
    if (!contentElement || !input.conversationId) return;
    const start = `${input.conversationId}:${input.startAtLink ? "link" : "start"}`;
    if (startedRef.current === start) return;

    const root = scrollRootFor(contentElement);
    if (!root) return;

    startedRef.current = start;
    setHasPendingUpdate(false);
    // The link scrolls to its row, maybe before this runs. Do not move away.
    if (input.startAtLink) {
      previousScrollTopRef.current = scrollSnapshot(root).scrollTop;
      setFollowingIntent(false);
      return;
    }
    if (input.startAtUnread && openAtUnreadMarker()) return;

    setScrollTop(root, scrollSnapshot(root).scrollHeight);
    previousScrollTopRef.current = scrollSnapshot(root).scrollTop;
    // Without unread rows, start at the latest message. Keep following until
    // the reader scrolls up so late content and footer layout cannot expose
    // stale space below the transcript.
    setFollowingIntent(true);
    awaitingUnreadMarkerRef.current = Boolean(input.startAtUnread);
  }, [
    contentElement,
    input.conversationId,
    input.startAtLink,
    input.startAtUnread,
    openAtUnreadMarker,
    setFollowingIntent,
  ]);

  // Follow the latest message, unless the "New" marker appeared before the
  // reader moved. Then open at the marker, as if it was there at the start.
  const followLatest = useCallback(() => {
    if (awaitingUnreadMarkerRef.current && openAtUnreadMarker()) return;
    if (!endsAtLatestRef.current) {
      setFollowingIntent(false);
      restorePlace();
      return;
    }
    scrollToBottom("auto");
  }, [openAtUnreadMarker, restorePlace, scrollToBottom, setFollowingIntent]);

  const syncAfterLayoutChange = useCallback(() => {
    if (followingRef.current) {
      followLatest();
      return;
    }

    restorePlace();
    measurePosition("measure");
  }, [followLatest, measurePosition, restorePlace]);

  // An earlier page renders above the reader. Hold their place before paint;
  // a reader at the bottom stays at the latest message.
  useBrowserLayoutEffect(() => {
    syncAfterLayoutChange();
  }, [input.historyVersion, syncAfterLayoutChange]);

  useBrowserLayoutEffect(() => {
    // Compare the same view across snapshots, not one view's tail to another.
    const tailChanged =
      versionsRef.current[input.view] !== input.versions[input.view];
    versionsRef.current = input.versions;
    const wasEnabled = enabledRef.current;
    if (initializedRef.current && !tailChanged && wasEnabled === input.enabled)
      return;

    const shouldTrack = input.enabled || wasEnabled;
    enabledRef.current = input.enabled;
    if (!shouldTrack) return;

    const wasInitialized = initializedRef.current;
    if (!initializedRef.current) {
      initializedRef.current = true;
    }

    if (input.enabled && !wasEnabled) {
      const root = scrollRootFor(contentElementRef.current);
      if (root) {
        setFollowingIntent(isNearScrollBottom(scrollSnapshot(root)));
      }
    }

    // New activity must preserve scroll-away intent on mobile and desktop.
    // The reader can resume following with the jump control or by scrolling down.
    if (
      shouldAutoPinTranscriptBottom({
        enabled: input.enabled,
        following: followingRef.current,
      })
    ) {
      followLatest();
      setHasPendingUpdate(false);
      return;
    }

    if (input.enabled && wasInitialized) {
      setHasPendingUpdate(true);
    }
  }, [
    input.enabled,
    input.view,
    input.versions.rich,
    input.versions.raw,
    followLatest,
    setFollowingIntent,
  ]);

  useEffect(() => {
    if (typeof window === "undefined" || !contentElement) return;

    const root = scrollRootFor(contentElement);
    if (!root) return;

    // Both a scrolling element and the window send these events.
    const target: GlobalEventHandlers = root;
    const onScroll = () => measurePosition("scroll");
    // Wheel and touch show intent before the scroll event. A live update in
    // that gap must not pull a reader who starts to scroll up back down.
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) leaveBottom();
    };
    // Compare with the highest finger point in this drag, so small steps
    // still add up to a drag down.
    let touchTopY: number | null = null;
    const onTouchStart = (event: TouchEvent) => {
      touchTopY = event.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY;
      if (y === undefined || touchTopY === null) return;
      if (y > touchTopY + USER_SCROLL_DELTA_PX) leaveBottom();
      touchTopY = Math.min(touchTopY, y);
    };

    measurePosition("measure");
    rememberPlace();
    // Listen on the scroll root, so gestures outside transcript rows count.
    // Capture runs first at the root, so the place is recorded before a
    // virtual list mounts the rows for the new position.
    target.addEventListener("scroll", onScroll, {
      capture: true,
      passive: true,
    });
    target.addEventListener("wheel", onWheel, { passive: true });
    target.addEventListener("touchstart", onTouchStart, {
      passive: true,
    });
    target.addEventListener("touchmove", onTouchMove, {
      passive: true,
    });
    window.addEventListener("resize", syncAfterLayoutChange);
    return () => {
      target.removeEventListener("scroll", onScroll, { capture: true });
      target.removeEventListener("wheel", onWheel);
      target.removeEventListener("touchstart", onTouchStart);
      target.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("resize", syncAfterLayoutChange);
    };
  }, [
    contentElement,
    leaveBottom,
    measurePosition,
    rememberPlace,
    syncAfterLayoutChange,
  ]);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    if (!contentElement) return;

    const observer = new ResizeObserver(() => {
      syncAfterLayoutChange();
    });
    observer.observe(contentElement);
    // Footer growth shrinks the transcript scroll root without resizing the
    // transcript content node. Watch the root so follow mode stays pinned.
    const root = scrollRootFor(contentElement);
    if (root && !isWindowRoot(root)) observer.observe(root);
    return () => observer.disconnect();
  }, [contentElement, syncAfterLayoutChange]);

  const jumpToBottom = useCallback(() => {
    awaitingUnreadMarkerRef.current = false;
    setFollowingIntent(true);
    setHasPendingUpdate(false);
    scrollToBottom(preferredExplicitScrollBehavior());
  }, [scrollToBottom, setFollowingIntent]);

  // Detail status updates before the deferred transcript. Save follow intent at
  // completion, then consume it when the terminal Junior reply arrives.
  useBrowserLayoutEffect(() => {
    const juniorMessageChanged =
      juniorMessageVersionRef.current !== input.juniorMessageVersion;
    juniorMessageVersionRef.current = input.juniorMessageVersion;
    const state = terminalReplyPinState({
      enabled: input.enabled,
      following: followingRef.current,
      juniorMessageChanged,
      pending: terminalPinPendingRef.current,
      wasEnabled: terminalEnabledRef.current,
    });
    terminalEnabledRef.current = input.enabled;
    terminalPinPendingRef.current = state.pending;
    if (!state.pin) return;
    setFollowingIntent(true);
    setHasPendingUpdate(false);
    scrollToBottom("auto");
  }, [
    input.enabled,
    input.juniorMessageVersion,
    scrollToBottom,
    setFollowingIntent,
  ]);

  useBrowserLayoutEffect(() => {
    const version = input.pinRequestVersion ?? 0;
    if (version === pinRequestVersionRef.current) return;
    pinRequestVersionRef.current = version;
    // The reader asked for the latest event, not the "New" marker.
    awaitingUnreadMarkerRef.current = false;
    setFollowingIntent(true);
    setHasPendingUpdate(false);
    scrollToBottom("auto");
  }, [input.pinRequestVersion, scrollToBottom, setFollowingIntent]);

  const scrollAnchorKey = useCallback(() => scrollAnchorRef.current?.key, []);

  return useMemo(
    () => ({
      anchorRef,
      contentElement,
      contentRef,
      hasPendingUpdate,
      jumpToBottom,
      scrollAnchorKey,
      showRow,
      showJumpToLatest: shouldShowJumpToLatest({
        enabled: input.enabled,
        endsAtLatest: input.endsAtLatest,
        following,
        hasPendingUpdate,
        openedAtUnread,
      }),
    }),
    [
      contentElement,
      contentRef,
      following,
      hasPendingUpdate,
      input.enabled,
      input.endsAtLatest,
      jumpToBottom,
      openedAtUnread,
      scrollAnchorKey,
      showRow,
    ],
  );
}

/** Jump to the latest row from inside the transcript, like the floating pill. */
export const TranscriptJumpToLatestContext = createContext<
  (() => void) | undefined
>(undefined);

/**
 * Load the next history page when the reader scrolls near the edge where it
 * goes: the top for earlier pages, the bottom for newer pages.
 */
export function useAutoLoadHistoryPage(input: {
  edge: "bottom" | "top";
  enabled: boolean;
  historyVersion: string;
  onLoad: () => void;
}): RefCallback<HTMLElement> {
  const [sentinel, setSentinel] = useState<HTMLElement | null>(null);
  const onLoadRef = useRef(input.onLoad);
  onLoadRef.current = input.onLoad;

  useEffect(() => {
    if (!input.enabled || !sentinel) return;
    if (typeof IntersectionObserver === "undefined") return;

    const root = scrollRootFor(sentinel);
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        onLoadRef.current();
      },
      {
        root: root && !isWindowRoot(root) ? root : null,
        rootMargin:
          input.edge === "top"
            ? `${HISTORY_PAGE_PROXIMITY_PX}px 0px 0px 0px`
            : `0px 0px ${HISTORY_PAGE_PROXIMITY_PX}px 0px`,
      },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [input.edge, input.enabled, input.historyVersion, sentinel]);

  return setSentinel;
}

/** Find the nearest element that scrolls the transcript, or the window. */
export function scrollRootFor(element: HTMLElement | null): ScrollRoot | null {
  if (typeof window === "undefined") return null;
  if (!element) return window;

  let current = element.parentElement;
  while (current && current !== document.body) {
    const style = window.getComputedStyle(current);
    if (/(auto|scroll|overlay)/.test(style.overflowY)) return current;
    current = current.parentElement;
  }

  return window;
}

function scrollSnapshot(root: ScrollRoot): ScrollSnapshot {
  if (isWindowRoot(root)) {
    const element = document.scrollingElement ?? document.documentElement;
    return {
      clientHeight: window.innerHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: window.scrollY || element.scrollTop,
    };
  }

  return {
    clientHeight: root.clientHeight,
    scrollHeight: root.scrollHeight,
    scrollTop: root.scrollTop,
  };
}

function setScrollTop(
  root: ScrollRoot,
  scrollTop: number,
  behavior: ScrollBehavior = "auto",
): void {
  if (isWindowRoot(root)) {
    window.scrollTo({ behavior, top: scrollTop });
    return;
  }
  root.scrollTo({ behavior, top: scrollTop });
}

/** Read the visible band of a scroll root in client coordinates. */
function viewportBounds(root: ScrollRoot): { bottom: number; top: number } {
  if (isWindowRoot(root)) return { bottom: window.innerHeight, top: 0 };
  const top = root.getBoundingClientRect().top;
  return { bottom: top + root.clientHeight, top };
}

function isWindowRoot(root: ScrollRoot): root is Window {
  return root === window;
}

function preferredExplicitScrollBehavior(): ScrollBehavior {
  if (typeof window === "undefined") return "auto";
  if (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    return "auto";
  }
  return "smooth";
}
