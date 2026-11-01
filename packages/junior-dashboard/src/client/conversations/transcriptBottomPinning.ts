import {
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
const PREVIOUS_PAGE_PROXIMITY_PX = 600;
const USER_SCROLL_DELTA_PX = 2;

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
  contentRef: RefCallback<HTMLDivElement>;
  hasPendingUpdate: boolean;
  jumpToBottom: () => void;
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
    data.type === "compaction" ||
    data.type === "handoff"
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
    case "handoff":
      return [
        data.type,
        data.modelProfile,
        data.modelId,
        data.summary?.length ?? 0,
        event.createdAt,
      ].join(":");
    case "turn_routed":
      return [data.type, data.turnId, data.modelProfile, data.modelId].join(
        ":",
      );
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
 * arrived. Staying pinned, or intentionally following, must not flash it.
 */
export function shouldShowJumpToLatest(input: {
  enabled: boolean;
  following: boolean;
  hasPendingUpdate: boolean;
}): boolean {
  return input.enabled && !input.following && input.hasPendingUpdate;
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
  historyVersion: string;
  juniorMessageVersion: string;
  pinRequestVersion?: number;
  view: TranscriptViewMode;
  versions: Record<TranscriptViewMode, string>;
}): BottomPinResult {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const contentElementRef = useRef<HTMLDivElement | null>(null);
  const enabledRef = useRef(input.enabled);
  const followingRef = useRef(false);
  const initializedRef = useRef(false);
  const initializedConversationRef = useRef<string | null>(null);
  const previousScrollTopRef = useRef<number | null>(null);
  // The scroll position that the last restore set. Its scroll event is not
  // a reader scroll, so it must not change follow intent.
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

  const setFollowingIntent = useCallback((value: boolean) => {
    followingRef.current = value;
    setFollowing(value);
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

      if (source === "scroll") rememberPlace();
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

  useBrowserLayoutEffect(() => {
    if (!contentElement || !input.conversationId) return;
    if (initializedConversationRef.current === input.conversationId) return;

    const root = scrollRootFor(contentElement);
    if (!root) return;

    initializedConversationRef.current = input.conversationId;
    setScrollTop(root, scrollSnapshot(root).scrollHeight);
    previousScrollTopRef.current = scrollSnapshot(root).scrollTop;
    // Start every conversation at its latest message. Keep following until the
    // reader scrolls up so late content and footer layout cannot expose stale
    // space below the transcript.
    setFollowingIntent(true);
    setHasPendingUpdate(false);
  }, [contentElement, input.conversationId, setFollowingIntent]);

  const syncAfterLayoutChange = useCallback(() => {
    if (followingRef.current) {
      scrollToBottom("auto");
      return;
    }

    restorePlace();
    measurePosition("measure");
  }, [measurePosition, restorePlace, scrollToBottom]);

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
      scrollToBottom("auto");
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
    scrollToBottom,
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
    target.addEventListener("scroll", onScroll, { passive: true });
    target.addEventListener("wheel", onWheel, { passive: true });
    target.addEventListener("touchstart", onTouchStart, {
      passive: true,
    });
    target.addEventListener("touchmove", onTouchMove, {
      passive: true,
    });
    window.addEventListener("resize", syncAfterLayoutChange);
    return () => {
      target.removeEventListener("scroll", onScroll);
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
    setFollowingIntent(true);
    setHasPendingUpdate(false);
    scrollToBottom("auto");
  }, [input.pinRequestVersion, scrollToBottom, setFollowingIntent]);

  return useMemo(
    () => ({
      anchorRef,
      contentRef,
      hasPendingUpdate,
      jumpToBottom,
      showJumpToLatest: shouldShowJumpToLatest({
        enabled: input.enabled,
        following,
        hasPendingUpdate,
      }),
    }),
    [contentRef, following, hasPendingUpdate, input.enabled, jumpToBottom],
  );
}

/** Load the previous history page when the reader scrolls near the top. */
export function useAutoLoadPreviousPage(input: {
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
        rootMargin: `${PREVIOUS_PAGE_PROXIMITY_PX}px 0px 0px 0px`,
      },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [input.enabled, input.historyVersion, sentinel]);

  return setSentinel;
}

function scrollRootFor(element: HTMLElement | null): ScrollRoot | null {
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
