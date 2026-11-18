import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import { flushSync } from "react-dom";

/** One duration and easing for a card's height, as it opens, grows, or leaves. */
const HEIGHT_MS = 200;
const HEIGHT_EASE = "cubic-bezier(0.2, 0, 0, 1)";

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Animate a card's height from what it showed to what it shows now each
 * time `layout` changes, so the rows below it move with it in one motion.
 * A change mid-way starts from the height on screen.
 */
export function useAnimatedHeight(
  ref: RefObject<HTMLElement | null>,
  layout: string,
) {
  // The height on screen, as of the last layout. A layout effect runs
  // before the observer sees the new content, so this is the old height.
  const shown = useRef<number>(undefined);
  const layoutRef = useRef(layout);
  const run = useRef<Animation>(undefined);
  useEffect(() => {
    const card = ref.current;
    if (!card) return;
    const observer = new ResizeObserver(() => {
      shown.current = card.offsetHeight;
    });
    observer.observe(card);
    return () => observer.disconnect();
  }, [ref]);
  useLayoutEffect(() => {
    const card = ref.current;
    if (!card || layoutRef.current === layout) return;
    layoutRef.current = layout;
    const from = shown.current;
    run.current?.cancel();
    const to = card.offsetHeight;
    if (from === undefined || Math.abs(from - to) < 1 || reducedMotion())
      return;
    card.style.overflow = "clip";
    const animation = card.animate(
      [{ height: `${from}px` }, { height: `${to}px` }],
      { duration: HEIGHT_MS, easing: HEIGHT_EASE },
    );
    const done = () => {
      if (run.current === animation) card.style.overflow = "";
    };
    animation.onfinish = done;
    animation.oncancel = done;
    run.current = animation;
  }, [ref, layout]);
}

/**
 * Close a card's height and fade it, so the rows below close the gap. It
 * resolves once the card is shut, at once under reduced motion. The card
 * stays shut until it goes, or `restoreCard` opens it again.
 */
function leaveCard(card: HTMLElement): Promise<void> {
  if (reducedMotion()) return Promise.resolve();
  const gap = parseFloat(getComputedStyle(card.parentElement ?? card).rowGap);
  card.style.overflow = "clip";
  card.style.pointerEvents = "none";
  const run = card.animate(
    [
      { height: `${card.offsetHeight}px`, marginBottom: "0px", opacity: 1 },
      {
        height: "0px",
        // The list's gap closes too, so nothing jumps when the card goes.
        marginBottom: `${-(Number.isFinite(gap) ? gap : 0)}px`,
        opacity: 0,
      },
    ],
    { duration: HEIGHT_MS, easing: HEIGHT_EASE, fill: "forwards" },
  );
  return run.finished.then(
    () => undefined,
    () => undefined,
  );
}

function restoreCard(card: HTMLElement): void {
  for (const run of card.getAnimations()) run.cancel();
  card.style.overflow = "";
  card.style.pointerEvents = "";
}

/** The top-level rows of a list, in reading order. */
function listRows(scroller: HTMLElement): HTMLElement[] {
  return [
    ...scroller.querySelectorAll<HTMLElement>(
      "[data-dock-list] > li[data-inbox-row]",
    ),
  ].filter((row) => !row.parentElement?.closest("li[data-inbox-row]"));
}

/**
 * Put a row away, as Dismiss or Snooze does. When the row was open, the
 * next row opens in its place at once, or the row before it at the end of
 * the list, so the reader keeps going. The row leaves with its height, then
 * `release` lets it go. A row that stays after `release`, as a Conversation
 * row without its asks, shows its card again. Returns the key of the row
 * that opened, if one did.
 */
export function useLeaveRow(
  scroller: RefObject<HTMLElement | null>,
  expandedKey: string,
  setExpandedKey: (key: string) => void,
) {
  return (key: string, release: () => void): string | undefined => {
    const area = scroller.current;
    const rows = area ? listRows(area) : [];
    const at = rows.findIndex((row) => row.dataset["inboxRow"] === key);
    const card = rows[at];
    if (!card) {
      release();
      return undefined;
    }
    const next = (rows[at + 1] ?? rows[at - 1])?.dataset["inboxRow"] ?? "";
    const opened = expandedKey === key ? next : undefined;
    if (opened !== undefined) setExpandedKey(opened);
    void leaveCard(card).then(() => {
      // The row goes now, before its shut card shows again.
      flushSync(release);
      if (card.isConnected) restoreCard(card);
    });
    return opened;
  };
}

/**
 * After a failed action brings a row back, scroll it into view when it is
 * near the part of the list that shows. A row far away stays there. The
 * row can take a few frames to render again.
 */
export function showReturnedRow(
  scroller: HTMLElement,
  key: string,
  frames = 10,
) {
  const row = scroller.querySelector(`li[data-inbox-row="${CSS.escape(key)}"]`);
  if (!row) {
    if (frames > 0) {
      requestAnimationFrame(() => showReturnedRow(scroller, key, frames - 1));
    }
    return;
  }
  const area = scroller.getBoundingClientRect();
  const box = row.getBoundingClientRect();
  const near =
    box.bottom > area.top - area.height && box.top < area.bottom + area.height;
  if (near) {
    row.scrollIntoView({
      behavior: reducedMotion() ? "auto" : "smooth",
      block: "nearest",
    });
  }
}
