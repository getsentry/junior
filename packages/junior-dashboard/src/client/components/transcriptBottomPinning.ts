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

import type { ConversationTurn, TranscriptPart } from "../types";

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

/** Build a compact transcript-tail key so polling without content changes does not look new. */
export function transcriptBottomVersion(turns: ConversationTurn[]): string {
  const lastTurn = turns.at(-1);
  if (!lastTurn) return "empty";

  const messages =
    lastTurn.transcript.length > 0
      ? lastTurn.transcript
      : (lastTurn.transcriptMetadata ?? []);
  const lastMessage = messages.at(-1);
  const lastPart = lastMessage?.parts.at(-1);

  return [
    turns.length,
    lastTurn.id,
    lastTurn.status,
    messages.length,
    lastMessage?.role ?? "",
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

/** Keep live transcript updates visually pinned only while the reader intends to follow them. */
export function usePinnedTranscriptBottom(input: {
  enabled: boolean;
  version: string;
}): BottomPinResult {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const contentElementRef = useRef<HTMLDivElement | null>(null);
  const enabledRef = useRef(input.enabled);
  const everEnabledRef = useRef(input.enabled);
  const followingRef = useRef(false);
  const initializedRef = useRef(false);
  const previousScrollTopRef = useRef<number | null>(null);
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
    if (input.enabled) {
      everEnabledRef.current = true;
    } else {
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
    anchorRef.current?.scrollIntoView({ behavior, block: "end" });
  }, []);

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
    if (input.enabled) everEnabledRef.current = true;
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
      showJumpToLatest: input.enabled && !following,
    }),
    [following, hasPendingUpdate, input.enabled, jumpToBottom],
  );
}

function transcriptPartVersion(part: TranscriptPart | undefined): string {
  if (!part) return "";

  return [
    part.type,
    part.id ?? "",
    part.name ?? "",
    part.chars ?? part.text?.length ?? "",
    part.bytes ?? "",
    part.inputSizeChars ?? "",
    part.inputSizeBytes ?? "",
    part.outputSizeChars ?? outputLength(part.output),
    part.outputSizeBytes ?? "",
    part.redacted ? "redacted" : "",
  ].join(":");
}

function outputLength(output: unknown): number | string {
  if (typeof output === "string") return output.length;
  if (output == null) return "";
  return "";
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
