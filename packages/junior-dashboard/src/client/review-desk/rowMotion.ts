import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";

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
 * Put a row away, as Dismiss or Snooze does: it leaves with its height,
 * then `work` takes it out. When the row was open, the next row opens in
 * its place, or the row before it at the end of the list, so the reader
 * keeps going. A row that `work` keeps, as when it fails, opens again.
 */
export function useLeaveRow(
  scroller: RefObject<HTMLElement | null>,
  expandedKey: string,
  setExpandedKey: (key: string) => void,
) {
  return (key: string, work: () => Promise<void> | void) => {
    const area = scroller.current;
    const rows = area ? listRows(area) : [];
    const at = rows.findIndex((row) => row.dataset.inboxRow === key);
    const card = rows[at];
    if (!card) return void work();
    const next = (rows[at + 1] ?? rows[at - 1])?.dataset.inboxRow;
    const wasOpen = expandedKey === key;
    void (async () => {
      await leaveCard(card);
      if (wasOpen) setExpandedKey(next ?? "");
      await work();
      if (card.isConnected) restoreCard(card);
    })();
  };
}
