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

const BOTTOM_PROXIMITY_PX = 96;
const MOBILE_MEDIA_QUERY = "(max-width: 767px)";
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
  preserveViewportForPrepend: () => void;
  showJumpToLatest: boolean;
};

type PrependSnapshot = {
  historyVersion: string;
  root: ScrollRoot;
  scrollHeight: number;
  scrollTop: number;
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

/** Build a compact transcript-tail key so polling without content changes does not look new. */
/** Build a version that changes only when a visible Junior message appears. */
export function transcriptJuniorMessageVersion(
  conversation: ConversationTranscript | undefined,
): string {
  if (!conversation) return "empty";
  for (let index = conversation.events.length - 1; index >= 0; index -= 1) {
    const event = conversation.events[index]!;
    const data = event.data;
    if (data.type !== "message" || data.role !== "assistant") continue;
    return [
      event.seq,
      event.createdAt,
      data.messageId,
      data.redacted ? "redacted" : (data.text?.length ?? 0),
    ].join(":");
  }
  return "empty";
}

export function transcriptBottomVersion(
  conversation: ConversationTranscript | undefined,
): string {
  if (!conversation) return "empty";

  // Read only the live tail event. Rebuilding the full transcript model on every
  // poll is too expensive while the reader is typing, and earlier history must
  // not look like a new bottom update when it is prepended.
  const last = conversation.events.at(-1);

  return [
    conversation.conversationId,
    conversation.status,
    last?.seq ?? "",
    last?.createdAt ?? "",
    eventTailVersion(last),
  ].join("|");
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
        "failureKind" in data ? data.failureKind : "",
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
      return [data.type, data.turnId, data.toolCallId, data.decision].join(
        ":",
      );
    case "turn_context":
      return [data.type, data.turnId, data.pluginName, data.kind, data.version].join(
        ":",
      );
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

/** Decide when a requested history prepend can restore or discard its viewport snapshot. */
export function prependViewportIntent(input: {
  currentHistoryVersion: string;
  loadingPreviousPage: boolean;
  snapshotHistoryVersion: string;
}): "discard" | "restore" | "wait" {
  if (input.loadingPreviousPage) return "wait";
  if (input.currentHistoryVersion !== input.snapshotHistoryVersion) {
    return "restore";
  }
  return "discard";
}

/** Keep live transcript updates visually pinned only while the reader intends to follow them. */
export function usePinnedTranscriptBottom(input: {
  conversationId?: string;
  enabled: boolean;
  historyVersion: string;
  juniorMessageVersion: string;
  loadingPreviousPage: boolean;
  pinRequestVersion?: number;
  version: string;
}): BottomPinResult {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const contentElementRef = useRef<HTMLDivElement | null>(null);
  const enabledRef = useRef(input.enabled);
  const followingRef = useRef(false);
  const initializedRef = useRef(false);
  const initializedConversationRef = useRef<string | null>(null);
  const previousScrollTopRef = useRef<number | null>(null);
  const prependSnapshotRef = useRef<PrependSnapshot | null>(null);
  const pinRequestVersionRef = useRef(input.pinRequestVersion ?? 0);
  const juniorMessageVersionRef = useRef(input.juniorMessageVersion);
  const versionRef = useRef(input.version);
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
    if (!input.enabled) {
      followingRef.current = false;
      setFollowing(false);
      setHasPendingUpdate(false);
    }
  }, [input.enabled]);

  const setFollowingIntent = useCallback((value: boolean) => {
    followingRef.current = value;
    setFollowing(value);
  }, []);

  const measurePosition = useCallback(
    (source: PositionMeasureSource) => {
      const root = scrollRootFor(contentElementRef.current);
      if (!root) return;

      const snapshot = scrollSnapshot(root);
      const previousScrollTop = previousScrollTopRef.current;
      previousScrollTopRef.current = snapshot.scrollTop;

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
    [setFollowingIntent],
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

  const preserveViewportForPrepend = useCallback(() => {
    const root = scrollRootFor(contentElementRef.current);
    if (!root) return;
    const snapshot = scrollSnapshot(root);
    prependSnapshotRef.current = {
      historyVersion: input.historyVersion,
      root,
      scrollHeight: snapshot.scrollHeight,
      scrollTop: snapshot.scrollTop,
    };
  }, [input.historyVersion]);

  useBrowserLayoutEffect(() => {
    if (!contentElement || !input.conversationId) return;
    if (initializedConversationRef.current === input.conversationId) return;

    const root = scrollRootFor(contentElement);
    if (!root) return;

    initializedConversationRef.current = input.conversationId;
    setScrollTop(root, scrollSnapshot(root).scrollHeight);
    previousScrollTopRef.current = scrollSnapshot(root).scrollTop;
    setFollowingIntent(input.enabled);
    setHasPendingUpdate(false);
  }, [contentElement, input.conversationId, input.enabled, setFollowingIntent]);

  useBrowserLayoutEffect(() => {
    const previous = prependSnapshotRef.current;
    if (!previous) return;

    const intent = prependViewportIntent({
      currentHistoryVersion: input.historyVersion,
      loadingPreviousPage: input.loadingPreviousPage,
      snapshotHistoryVersion: previous.historyVersion,
    });
    if (intent === "restore") {
      const current = scrollSnapshot(previous.root);
      setScrollTop(
        previous.root,
        scrollTopAfterPrepend(previous, current.scrollHeight),
      );
      prependSnapshotRef.current = null;
      return;
    }

    if (intent === "discard") prependSnapshotRef.current = null;
  }, [input.historyVersion, input.loadingPreviousPage]);

  const syncAfterLayoutChange = useCallback(() => {
    if (
      shouldAutoPinTranscriptBottom({
        enabled: enabledRef.current,
        following: followingRef.current,
      })
    ) {
      scrollToBottom("auto");
      return;
    }

    measurePosition("measure");
  }, [measurePosition, scrollToBottom]);

  // Mobile product contract: while live, new tail content always follows.
  // Still require live mode so a completed/status-only version flip does not jump.
  useBrowserLayoutEffect(() => {
    if (versionRef.current === input.version) return;
    versionRef.current = input.version;
    if (
      !input.enabled ||
      typeof window === "undefined" ||
      !window.matchMedia(MOBILE_MEDIA_QUERY).matches
    ) {
      return;
    }
    setFollowingIntent(true);
    setHasPendingUpdate(false);
    scrollToBottom("auto");
  }, [input.enabled, input.version, scrollToBottom, setFollowingIntent]);

  useBrowserLayoutEffect(() => {
    const wasEnabled = enabledRef.current;
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
  }, [input.enabled, input.version, scrollToBottom, setFollowingIntent]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const root = scrollRootFor(contentElement);
    if (!root) return;

    const target: HTMLElement | Window = root === window ? window : root;
    const onScroll = () => measurePosition("scroll");

    measurePosition("measure");
    target.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", syncAfterLayoutChange);
    return () => {
      target.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", syncAfterLayoutChange);
    };
  }, [contentElement, measurePosition, syncAfterLayoutChange]);

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

  // A Junior reply can arrive in the same poll that completes the conversation.
  // Pin it independently from live-follow state so the terminal reply is visible.
  useBrowserLayoutEffect(() => {
    if (juniorMessageVersionRef.current === input.juniorMessageVersion) return;
    juniorMessageVersionRef.current = input.juniorMessageVersion;
    setFollowingIntent(true);
    setHasPendingUpdate(false);
    scrollToBottom("auto");
  }, [input.juniorMessageVersion, scrollToBottom, setFollowingIntent]);

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
      preserveViewportForPrepend,
      showJumpToLatest: shouldShowJumpToLatest({
        enabled: input.enabled,
        following,
        hasPendingUpdate,
      }),
    }),
    [
      contentRef,
      following,
      hasPendingUpdate,
      input.enabled,
      jumpToBottom,
      preserveViewportForPrepend,
    ],
  );
}

/** Keep the previously visible content at the same viewport offset after a prepend. */
export function scrollTopAfterPrepend(
  previous: Pick<ScrollSnapshot, "scrollHeight" | "scrollTop">,
  scrollHeight: number,
): number {
  return previous.scrollTop + scrollHeight - previous.scrollHeight;
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
