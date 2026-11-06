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
const PIN_START_ATTRIBUTE = "data-transcript-pin-start";
const PIN_START_MARGIN_PX = 16;

/**
 * Mark a tall block whose start the reader must see first, such as a Review
 * item card. The value is a stable id, so each block moves the view only once.
 */
export function transcriptPinStartProps(id: string) {
  return { [PIN_START_ATTRIBUTE]: id };
}

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
  /** Report a visible change below the reader that no version shows. */
  noticeUpdate: () => void;
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
 * Show the jump control only when the reader left the bottom and a visible
 * update arrived, when the transcript opened at unread rows, or when it does
 * not end at the latest event. Staying pinned, or intentionally following,
 * must not flash it.
 */
export function shouldShowJumpToLatest(input: {
  endsAtLatest?: boolean;
  following: boolean;
  hasPendingUpdate: boolean;
  openedAtUnread?: boolean;
}): boolean {
  return (
    !input.following &&
    (input.endsAtLatest === false ||
      Boolean(input.openedAtUnread) ||
      input.hasPendingUpdate)
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
  conversationId?: string;
  enabled: boolean;
  /**
   * False while newer pages are not loaded. The end of the transcript is
   * then not the latest event, so the reader cannot follow it, and a page
   * that loads below them does not pull them down.
   */
  endsAtLatest?: boolean;
  historyVersion: string;
  juniorMessageVersion: string;
  /**
   * Changes when an update that the reader can see arrives. Without it, each
   * change of the view's tail counts.
   */
  noticeVersion?: string;
  pinRequestVersion?: number;
  /** Open where a link shows its row, not at the latest message. */
  startAtLink?: boolean;
  /** Open at the "New" marker when the transcript has one. */
  startAtUnread?: boolean;
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
  const noticeVersion = input.noticeVersion ?? input.versions[input.view];
  const noticeVersionRef = useRef(noticeVersion);
  const programmaticScrollGenerationRef = useRef(0);
  const seenPinStartsRef = useRef(new Set<string>());
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

  // A pending update stays after the Turn ends, so the reader can find the
  // reply that ended it.
  useEffect(() => {
    enabledRef.current = input.enabled;
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

      // A new block that does not fit shows its start, not its end. Stop
      // following, so later layout does not move the start out of view.
      const startTop = newPinStartScrollTop(
        root,
        contentElementRef.current,
        seenPinStartsRef.current,
      );
      if (startTop !== null) setFollowingIntent(false);

      // Only suppress pin-settle noise while still following. After the reader
      // leaves the bottom, do not open a window that can ignore their scroll.
      const suppressSettleNoise = startTop !== null || followingRef.current;
      const generation = suppressSettleNoise
        ? ++programmaticScrollGenerationRef.current
        : 0;
      setScrollTop(
        root,
        startTop ?? scrollSnapshot(root).scrollHeight,
        behavior,
      );

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
    const noticeChanged = noticeVersionRef.current !== noticeVersion;
    noticeVersionRef.current = noticeVersion;
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

    if (noticeChanged && wasInitialized) {
      setHasPendingUpdate(true);
    }
  }, [
    input.enabled,
    input.view,
    input.versions.rich,
    input.versions.raw,
    noticeVersion,
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

  const noticeUpdate = useCallback(() => {
    // A follower is already pinned to the change.
    if (enabledRef.current && !followingRef.current) setHasPendingUpdate(true);
  }, []);

  const scrollAnchorKey = useCallback(() => scrollAnchorRef.current?.key, []);

  return useMemo(
    () => ({
      anchorRef,
      contentElement,
      contentRef,
      hasPendingUpdate,
      jumpToBottom,
      noticeUpdate,
      scrollAnchorKey,
      showJumpToLatest: shouldShowJumpToLatest({
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
      input.endsAtLatest,
      jumpToBottom,
      noticeUpdate,
      openedAtUnread,
      scrollAnchorKey,
    ],
  );
}

/** Jump to the latest row from inside the transcript, like the floating pill. */
export const TranscriptJumpToLatestContext = createContext<
  (() => void) | undefined
>(undefined);

/** Report a visible change that the notice version cannot see. */
export const TranscriptNoticeUpdateContext = createContext<
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

/**
 * Return the scroll position that shows the start of the last pin-start block,
 * when a bottom pin would cut off its start. Each block counts once.
 */
function newPinStartScrollTop(
  root: ScrollRoot,
  content: HTMLElement | null,
  seen: Set<string>,
): number | null {
  const block = content
    ? Array.from(
        content.querySelectorAll<HTMLElement>(`[${PIN_START_ATTRIBUTE}]`),
      ).at(-1)
    : undefined;
  const id = block?.getAttribute(PIN_START_ATTRIBUTE);
  if (!block || !id || seen.has(id)) return null;
  const rect = block.getBoundingClientRect();
  // The block has no size until its data loads. Check it again then.
  if (rect.height === 0) return null;
  seen.add(id);

  const snapshot = scrollSnapshot(root);
  const offset =
    snapshot.scrollTop -
    (isWindowRoot(root) ? 0 : root.getBoundingClientRect().top);
  const startTop = rect.top + offset - PIN_START_MARGIN_PX;
  const bottomTop = snapshot.scrollHeight - snapshot.clientHeight;
  // Keep the bottom pin when it shows the start, or when the block is above it.
  if (startTop >= bottomTop || rect.bottom + offset <= bottomTop) return null;
  return Math.max(0, startTop);
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
