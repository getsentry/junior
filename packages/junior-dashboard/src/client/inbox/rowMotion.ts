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

// The sheet's close motion is 450ms. A sheet that stays longer goes with its
// row.
const SHEET_CLOSE_LIMIT_MS = 600;

// A row's sheet portals out of the row, so the row waits until the sheet
// finishes its close motion. A row that goes first takes the sheet with it.
function sheetGone(sheet: Element | null): Promise<void> {
  if (!sheet || reducedMotion()) return Promise.resolve();
  const start = performance.now();
  return new Promise((resolve) => {
    const check = () => {
      if (
        !sheet.isConnected ||
        performance.now() - start > SHEET_CLOSE_LIMIT_MS
      ) {
        resolve();
      } else {
        requestAnimationFrame(check);
      }
    };
    requestAnimationFrame(check);
  });
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
 * the list, so the reader keeps going. In a stack, a row of the same stack
 * opens first, also past its fold. The row leaves with its height, then
 * `release` lets it go. A row that stays after `release`, as a Conversation
 * row without its asks, shows its card again. A stack's key puts the whole
 * stack away the same way, and the next row after it opens. Returns the key
 * of the row that opened, if one did.
 */
export function useLeaveRow(
  scroller: RefObject<HTMLElement | null>,
  expandedKey: string,
  setExpandedKey: (key: string) => void,
  /** False closes an open row that leaves, as a phone's sheet does. */
  advance = true,
) {
  // A Retry calls a leave from an earlier render. Read the open row now.
  const expanded = useRef(expandedKey);
  expanded.current = expandedKey;
  /** `passing` names rows that go with this one, so none of them opens. */
  return (
    key: string,
    release: () => void,
    passing: ReadonlySet<string> = new Set(),
  ): string | undefined => {
    const area = scroller.current;
    const rows = area ? listRows(area) : [];
    const at = rows.findIndex((row) => row.dataset["inboxRow"] === key);
    // A stack's key puts the whole stack away, with every row in it.
    const whole = area?.querySelector<HTMLElement>(
      `li[data-inbox-stack="${CSS.escape(key)}"]`,
    );
    const card = rows[at] ?? whole;
    if (!card) {
      release();
      return undefined;
    }
    const inside = rows.filter((row) => whole?.contains(row));
    const first = whole ? rows.indexOf(inside[0]!) : at;
    const last = whole ? rows.indexOf(inside.at(-1)!) : at;
    const leaving = (row: HTMLElement) =>
      row.dataset["inboxRow"] === key || inside.includes(row);
    const stays = (row: HTMLElement) =>
      !leaving(row) && !passing.has(row.dataset["inboxRow"] ?? "");
    // A row of a stack goes to a row of its own stack first.
    const stack = whole ? undefined : card.closest("[data-inbox-stack]");
    const near = (row: HTMLElement) => stays(row) && !!stack?.contains(row);
    const after = rows.slice(last + 1);
    const before = rows.slice(0, Math.max(first, 0)).reverse();
    const next =
      (
        after.find(near) ??
        before.find(near) ??
        after.find(stays) ??
        before.find(stays)
      )?.dataset["inboxRow"] ?? "";
    const wasOpen = rows.find(
      (row) => row.dataset["inboxRow"] === expanded.current,
    );
    const opened =
      wasOpen && leaving(wasOpen) ? (advance ? next : "") : undefined;
    // A phone shows the open row in a sheet, which closes first.
    const sheet =
      opened === ""
        ? document.querySelector(
            `[data-inbox-sheet="${CSS.escape(expanded.current)}"]`,
          )
        : null;
    if (opened !== undefined) setExpandedKey(opened);
    void sheetGone(sheet)
      .then(() => leaveCard(card))
      .then(() => {
        // The row goes now, before its shut card shows again.
        flushSync(release);
        if (card.isConnected) restoreCard(card);
      });
    return opened;
  };
}

/**
 * Put one card of an open row away, as its Dismiss or Snooze does: it
 * leaves with its height, then `release` lets it go, and the next card of
 * the row takes focus, or the card before it at the end. The last card
 * leaves with its row (`leaveRow`), so the next row opens. A card that
 * stays after `release`, as when its action failed, comes back. Returns the
 * key of the row that opened, if one did.
 */
export function useLeaveCard(
  scroller: RefObject<HTMLElement | null>,
  leaveRow: ReturnType<typeof useLeaveRow>,
) {
  return (
    key: string,
    itemId: string,
    release: () => void,
  ): string | undefined => {
    const area = scroller.current;
    const row = area
      ? listRows(area).find(
          (candidate) => candidate.dataset["inboxRow"] === key,
        )
      : undefined;
    // On a phone, an open row's cards are in its sheet.
    const sheet = row
      ? document.querySelector(`[data-inbox-sheet="${CSS.escape(key)}"]`)
      : null;
    const cards = row
      ? [...(sheet ?? row).querySelectorAll<HTMLElement>("[data-inbox-card]")]
      : [];
    const at = cards.findIndex((card) => card.dataset["inboxCard"] === itemId);
    const card = cards[at];
    // A shut row shows no cards, so the row itself leaves.
    if (row && cards.length === 0) return leaveRow(key, release);
    // A card that does not show, as a folded notice, has no motion.
    if (!card) {
      release();
      return undefined;
    }
    if (cards.length === 1) return leaveRow(key, release);
    const next = cards[at + 1] ?? cards[at - 1];
    void leaveCard(card).then(() => {
      flushSync(release);
      if (card.isConnected) return restoreCard(card);
      next?.focus({ preventScroll: true });
      next?.scrollIntoView({ block: "nearest" });
    });
    return undefined;
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
  const row = scroller.querySelector(
    `li[data-inbox-row="${CSS.escape(key)}"], li[data-inbox-stack="${CSS.escape(key)}"]`,
  );
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
