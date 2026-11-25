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
  isWindowRoot,
  preferredExplicitScrollBehavior,
  scrollRootFor,
  scrollSnapshot,
  setScrollTop,
  viewportBounds,
} from "./transcriptScrollRoot";
import {
  captureRowAnchor,
  captureScrollAnchor,
  scrollAnchorShift,
  type ScrollAnchor,
} from "./transcriptScrollAnchor";

const BOTTOM_PROXIMITY_PX = 96;
const HISTORY_PAGE_PROXIMITY_PX = 600;
/** Viewports of content below the reader before the jump control shows. */
const FAR_FROM_BOTTOM_VIEWPORTS = 2;
const USER_SCROLL_DELTA_PX = 2;
// Leave a little earlier context above the "New" marker.
const UNREAD_START_OFFSET_PX = 48;
// Leave a little earlier context above a row taller than the viewport.
const TALL_ROW_TOP_GAP_PX = 48;

type PositionMeasureSource = "measure" | "scroll";

export type TranscriptFollowIntent = "follow" | "pause" | "preserve";

/** Show a row, and leave follow when the row is not at the latest. */
export type ShowTranscriptRow = (
  row: Element,
  options?: { instant?: boolean },
) => boolean;

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
   * Show a mounted row that the reader asks for. It moves to the middle of
   * the viewport, or its start to the top when it does not fit. An
   * `instant` move skips smooth scrolling. Returns false when the row does
   * not show.
   */
  showRow: ShowTranscriptRow;
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

type EventData<T extends ConversationReportEvent["data"]["type"]> = Extract<
  ConversationReportEvent["data"],
  { type: T }
>;
type EventTailVersions = {
  [T in ConversationReportEvent["data"]["type"]]: (
    data: EventData<T>,
    event: ConversationReportEvent,
  ) => string;
};

const EVENT_TAIL_VERSIONS = {
  message: (data) =>
    [
      data.type,
      data.role,
      data.messageId,
      data.redacted ? "redacted" : (data.text?.length ?? 0),
      data.eventType ?? "",
    ].join(":"),
  assistant_message: (data) => {
    const parts = data.parts;
    const lastPart = parts.at(-1);
    return [
      data.type,
      parts.length,
      lastPart?.redacted ? "redacted" : (lastPart?.text?.length ?? 0),
    ].join(":");
  },
  tool_calls: (data) => {
    const call = data.calls.at(-1);
    return [
      data.type,
      data.calls.length,
      call?.toolCallId ?? "",
      call?.name ?? "",
      call?.status ?? "",
      call?.output === undefined ? "" : "output",
    ].join(":");
  },
  subagent: (data) =>
    [
      data.type,
      data.childConversationId,
      data.status,
      data.subagentKind,
      data.parentToolCallId ?? "",
    ].join(":"),
  turn_lifecycle: (data) =>
    [
      data.type,
      data.turnId,
      data.state,
      "failureCode" in data ? data.failureCode : "",
      "failureReason" in data ? (data.failureReason ?? "") : "",
    ].join(":"),
  structured_event: (data) =>
    [
      data.type,
      data.namespace,
      data.name,
      data.version,
      data.presentation.title,
      data.presentation.preview?.length ?? 0,
    ].join(":"),
  message_handled: (data) => [data.type, data.messageId].join(":"),
  attachments_delivered: (data) =>
    [
      data.type,
      data.attachments.length,
      ...data.attachments.map(
        (attachment) =>
          `${attachment.id}:${attachment.filename}:${attachment.bytes}`,
      ),
    ].join(":"),
  compaction: (data, event) =>
    [data.type, data.summary?.length ?? 0, event.createdAt].join(":"),
  guardian_action_reviewed: (data) =>
    [data.type, data.turnId, data.toolCallId, data.decision].join(":"),
  turn_context: (data) =>
    [data.type, data.turnId, data.pluginName, data.kind, data.version].join(
      ":",
    ),
  reply_posted: (data, event) => `${data.type}:${event.seq}`,
} satisfies EventTailVersions;

function dataTailVersion<T extends ConversationReportEvent["data"]["type"]>(
  data: EventData<T>,
  event: ConversationReportEvent,
): string {
  const version: EventTailVersions[T] = EVENT_TAIL_VERSIONS[data.type];
  return version(data, event);
}

function eventTailVersion(event: ConversationReportEvent | undefined): string {
  if (!event) return "";
  const data = event.data;
  if (!Object.hasOwn(EVENT_TAIL_VERSIONS, data.type)) {
    return `${(data as { type?: string }).type ?? "unknown"}:${event.seq}`;
  }
  return dataTailVersion(data, event);
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
 * arrived, when the transcript opened at unread rows, when it does not end
 * at the latest event, or when the reader scrolled far up a long transcript.
 * Staying pinned, or intentionally following, must not flash it.
 */
export function shouldShowJumpToLatest(input: {
  enabled: boolean;
  endsAtLatest?: boolean | undefined;
  /** More than a few viewports of content are below the reader. */
  farFromBottom?: boolean;
  following: boolean;
  hasPendingUpdate: boolean;
  openedAtUnread?: boolean;
}): boolean {
  return (
    !input.following &&
    (input.endsAtLatest === false ||
      Boolean(input.openedAtUnread) ||
      Boolean(input.farFromBottom) ||
      (input.enabled && input.hasPendingUpdate))
  );
}

/** True when more than `FAR_FROM_BOTTOM_VIEWPORTS` of content sit below the viewport. */
export function isFarFromScrollBottom(snapshot: ScrollSnapshot): boolean {
  const remaining =
    snapshot.scrollHeight - snapshot.scrollTop - snapshot.clientHeight;
  return remaining > snapshot.clientHeight * FAR_FROM_BOTTOM_VIEWPORTS;
}

/** True when the viewport touches the end of the content. */
function isAtScrollEnd(snapshot: ScrollSnapshot): boolean {
  return snapshot.scrollHeight - snapshot.scrollTop - snapshot.clientHeight < 1;
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
    // Content that shrinks, or a viewport that grows, clamps scrollTop down
    // to the new end. A reader who scrolls up never lands there, so a clamp
    // keeps the follow state. A jump leaves follow itself, in `showRow`.
    return isAtScrollEnd(input.snapshot) ? "preserve" : "pause";
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
  // True while the anchor is the row that a jump showed. Restores keep that
  // anchor, so the row stays put through later changes, such as a search
  // that clears. Any other anchor moves to the first row in view.
  const holdsShownRowRef = useRef(false);
  const pinRequestVersionRef = useRef(input.pinRequestVersion ?? 0);
  const juniorMessageVersionRef = useRef(input.juniorMessageVersion);
  const terminalEnabledRef = useRef(input.enabled);
  const terminalPinPendingRef = useRef(false);
  const versionsRef = useRef(input.versions);
  const programmaticScrollGenerationRef = useRef(0);
  const [following, setFollowing] = useState(false);
  const [farFromBottom, setFarFromBottom] = useState(false);
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
    holdsShownRowRef.current = false;
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
    if (shift === null || !holdsShownRowRef.current) rememberPlace();
  }, [rememberPlace]);

  const stopFollowing = useCallback(() => {
    if (!followingRef.current) return;
    programmaticScrollGenerationRef.current = 0;
    setFollowingIntent(false);
  }, [setFollowingIntent]);

  const leaveBottom = useCallback(() => {
    const root = scrollRootFor(contentElementRef.current);
    // Content that fits the viewport has nothing above to read.
    if (!root || scrollSnapshot(root).scrollTop <= 0) return;
    stopFollowing();
  }, [stopFollowing]);

  const measurePosition = useCallback(
    (source: PositionMeasureSource) => {
      const root = scrollRootFor(contentElementRef.current);
      if (!root) return;

      const snapshot = scrollSnapshot(root);
      const previousScrollTop = previousScrollTopRef.current;
      previousScrollTopRef.current = snapshot.scrollTop;
      setFarFromBottom(isFarFromScrollBottom(snapshot));

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
        // Away from the bottom, the reader moved after the pin. Its scroll
        // event can come after this callback, so keep the place that the
        // event compares with, or the move does not pause follow.
        if (!isNearScrollBottom(settled)) return;
        previousScrollTopRef.current = settled.scrollTop;
        if (enabledRef.current && followingRef.current) {
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
    (row: Element, options?: { instant?: boolean }): boolean => {
      const root = scrollRootFor(contentElementRef.current);
      if (!root) return false;
      const bounds = viewportBounds(root);
      const rect = row.getBoundingClientRect();
      const viewportHeight = bounds.bottom - bounds.top;
      // Hold the place on the shown row, not the first row in view.
      const holdShownRow = () => {
        scrollAnchorRef.current = captureRowAnchor(row, viewportBounds(root));
        holdsShownRowRef.current = scrollAnchorRef.current !== null;
      };
      // A row taller than the viewport shows from its start, not its middle.
      const offset =
        rect.top -
        bounds.top -
        (rect.height > viewportHeight
          ? TALL_ROW_TOP_GAP_PX
          : (viewportHeight - rect.height) / 2);
      // The reader goes to the row, so the latest must not pull them back.
      // Decide without the scroll geometry: a search can shrink the content
      // so that the row sits at its end, and clearing the search then shows
      // the latest far below the row.
      stopFollowing();
      if (Math.abs(offset) < 1) {
        holdShownRow();
        return true;
      }
      const scrollTop = Math.max(0, scrollSnapshot(root).scrollTop + offset);
      const behavior = options?.instant
        ? "auto"
        : preferredExplicitScrollBehavior();
      setScrollTop(root, scrollTop, behavior);
      // A layout change must not restore the place that the reader left.
      // A smooth scroll remembers each new place on its scroll events.
      if (behavior === "smooth") {
        holdsShownRowRef.current = false;
        scrollAnchorRef.current = null;
        return true;
      }
      const snapshot = scrollSnapshot(root);
      previousScrollTopRef.current = snapshot.scrollTop;
      restoredScrollTopRef.current = snapshot.scrollTop;
      holdShownRow();
      return true;
    },
    [stopFollowing],
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
        farFromBottom,
        following,
        hasPendingUpdate,
        openedAtUnread,
      }),
    }),
    [
      contentElement,
      contentRef,
      farFromBottom,
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
