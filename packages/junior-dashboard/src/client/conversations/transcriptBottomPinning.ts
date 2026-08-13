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

import type { ConversationTranscript, TranscriptViewPart } from "../types";
import { conversationTranscriptMessages } from "./eventTranscript";

const BOTTOM_PROXIMITY_PX = 96;
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
export function transcriptBottomVersion(
  conversation: ConversationTranscript | undefined,
): string {
  if (!conversation) return "empty";

  const messages = conversationTranscriptMessages(conversation);
  const lastMessage = messages.at(-1);
  const lastPart = lastMessage?.parts.at(-1);

  return [
    conversation.conversationId,
    conversation.status,
    lastMessage?.sourceSeq ?? "",
    lastMessage?.role ?? "",
    lastMessage?.outcome ?? "",
    lastMessage?.timestamp ?? "",
    lastMessage?.parts.length ?? 0,
    transcriptPartVersion(lastPart),
  ].join("|");
}

/** Require both live mode and reader intent before moving the viewport. */
export function shouldAutoPinTranscriptBottom(input: {
  enabled: boolean;
  following: boolean;
}): boolean {
  return input.enabled && input.following;
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

  if (isNearScrollBottom(input.snapshot)) return "follow";
  return "preserve";
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
  loadingPreviousPage: boolean;
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

  const scrollToBottom = useCallback((behavior: ScrollBehavior) => {
    const root = scrollRootFor(contentElementRef.current);
    if (!root) return;
    setScrollTop(root, scrollSnapshot(root).scrollHeight, behavior);
  }, []);

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

  useBrowserLayoutEffect(() => {
    const wasEnabled = enabledRef.current;
    const shouldTrack = input.enabled || wasEnabled;
    enabledRef.current = input.enabled;
    if (!shouldTrack) return;

    const wasInitialized = initializedRef.current;
    if (!initializedRef.current) {
      initializedRef.current = true;
      measurePosition("measure");
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
  }, [input.enabled, input.version, measurePosition, scrollToBottom]);

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
    return () => observer.disconnect();
  }, [contentElement, syncAfterLayoutChange]);

  const jumpToBottom = useCallback(() => {
    setFollowingIntent(true);
    setHasPendingUpdate(false);
    scrollToBottom(preferredExplicitScrollBehavior());
  }, [scrollToBottom, setFollowingIntent]);

  return useMemo(
    () => ({
      anchorRef,
      contentRef,
      hasPendingUpdate,
      jumpToBottom,
      preserveViewportForPrepend,
      showJumpToLatest: input.enabled && !following,
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

function transcriptPartVersion(part: TranscriptViewPart | undefined): string {
  if (!part) return "";
  if (part.type === "text") {
    return [
      part.type,
      part.text?.length ?? 0,
      part.redacted ? "redacted" : "",
    ].join(":");
  }
  if (part.type === "tool_call") {
    return [
      part.type,
      part.id,
      part.status,
      part.startedTimestamp ?? "",
      part.input === undefined ? "" : "input",
      part.output === undefined ? "" : "output",
    ].join(":");
  }
  if (part.type === "reasoning") {
    return [
      part.type,
      part.text?.length ?? 0,
      part.redacted ? "redacted" : "",
    ].join(":");
  }
  if (part.type === "subagent") {
    return [
      part.type,
      part.id,
      part.childConversationId,
      part.subagentKind,
      part.status,
    ].join(":");
  }
  if (part.type === "structured_event") {
    return [
      part.type,
      part.namespace,
      part.name,
      part.version,
      part.presentation.title,
      part.presentation.preview ?? "",
      part.presentation.details?.length ?? 0,
    ].join(":");
  }
  if (part.type === "attachments_delivered") {
    return [
      part.type,
      ...part.attachments.map(
        (attachment) =>
          `${attachment.id}:${attachment.filename}:${attachment.contentType}:${attachment.bytes}`,
      ),
    ].join(":");
  }
  return [part.type, part.event.type, part.event.createdAt].join(":");
}

function scrollRootFor(element: HTMLElement | null): ScrollRoot | null {
  if (typeof window === "undefined") return null;
  if (!element) return window;

  let current = element.parentElement;
  while (current && current !== document.body) {
    const style = window.getComputedStyle(current);
    if (
      /(auto|scroll|overlay)/.test(style.overflowY) &&
      current.scrollHeight > current.clientHeight
    ) {
      return current;
    }
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
