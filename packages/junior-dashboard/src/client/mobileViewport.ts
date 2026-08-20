import { useEffect, type RefObject } from "react";

import { acquireBodyScrollLock, releaseBodyScrollLock } from "./bodyScrollLock";

const viewportHeightProperty = "--dashboard-viewport-height";
const viewportOffsetTopProperty = "--dashboard-viewport-offset-top";
const keyboardOpenProperty = "--dashboard-keyboard-open";
/** Single owner for composer bottom pad. Call sites must not invent safe-area math. */
export const composerDockPaddingProperty =
  "--dashboard-composer-dock-padding";
// Ignore small visualViewport shrink from rubber-band and transient chrome.
// Real software keyboards reduce height by much more than this.
const KEYBOARD_OPEN_HEIGHT_DELTA_PX = 100;
// Ignore tiny visual offset jitter before the real iOS keyboard dock arrives.
// Real first-focus docks are far larger than rubber-band noise.
const MIN_FIRST_DOCK_OFFSET_PX = 24;
// Tight closed/open pad. Safe-area is intentionally omitted: with
// viewport-fit=cover + visualViewport shell docking, env(safe-area-inset-bottom)
// stacks a large home-indicator gap (and Safari often keeps it while the
// keyboard is open: https://bugs.webkit.org/show_bug.cgi?id=217754).
const COMPOSER_DOCK_PADDING = "0.375rem";

/** How the browser is resizing while the software keyboard is open. */
export type MobileViewportKeyboardMode =
  | "closed"
  | "resizes-content"
  | "resizes-visual";

export type MobileViewportMetrics = {
  heightPx: number;
  keyboardMode: MobileViewportKeyboardMode;
  keyboardOpen: boolean;
  offsetTopPx: number;
};

export type MobileViewportSyncSource =
  | "focusin"
  | "focusout"
  | "measure"
  | "resize"
  | "scroll";

const mobileViewportSyncPriority: Record<MobileViewportSyncSource, number> = {
  focusin: 2,
  focusout: 2,
  measure: 1,
  resize: 3,
  scroll: 0,
};

/** Keep the strongest viewport signal when browser events share one frame. */
export function coalescedMobileViewportSyncSource(
  current: MobileViewportSyncSource | undefined,
  next: MobileViewportSyncSource,
): MobileViewportSyncSource {
  if (current === undefined) return next;
  return mobileViewportSyncPriority[next] > mobileViewportSyncPriority[current]
    ? next
    : current;
}

/**
 * Map layout + visual viewport into shell geometry.
 *
 * Contract:
 * - closed keyboard: shell = layout viewport, offset 0 (ignore rubber-band)
 * - open keyboard: shell = visual viewport rectangle (height + offsetTop)
 *
 * Keyboard detection:
 * - resizes-visual: layout stays large, visual shrinks (Safari default)
 * - resizes-content: layout and visual shrink together. Trust the resting
 *   closed height only when an editor is focused or the visual viewport is
 *   already offset. A bare height drop (orientation change) must not stick
 *   keyboard-open forever against a stale resting value.
 *
 * Focus-time Safari pan freezes while typing use `mobileViewportOffsetTop`.
 */
export function mobileViewportMetrics(input: {
  editableFocused: boolean;
  layoutHeight: number;
  mobile: boolean;
  restingLayoutHeight: number;
  visualHeight: number;
  visualOffsetTop: number;
}): MobileViewportMetrics | null {
  if (!input.mobile) return null;

  const layoutHeight = Math.max(0, Math.round(input.layoutHeight));
  const visualHeight = Math.max(0, Math.round(input.visualHeight));
  const restingLayoutHeight = Math.max(
    0,
    Math.round(input.restingLayoutHeight),
  );
  const visualOffsetTop = Math.max(0, Math.round(input.visualOffsetTop));
  const layoutVisualDelta = layoutHeight - visualHeight;
  // Safari default: layout stays large while the keyboard shrinks visual.
  const resizesVisualOpen =
    layoutVisualDelta >= KEYBOARD_OPEN_HEIGHT_DELTA_PX;
  // resizes-content: both edges shrink together. Height alone is ambiguous
  // with orientation changes, so require focus or a non-zero visual offset.
  const bothShrunkTogether =
    Math.abs(layoutVisualDelta) < KEYBOARD_OPEN_HEIGHT_DELTA_PX &&
    restingLayoutHeight - Math.min(layoutHeight, visualHeight) >=
      KEYBOARD_OPEN_HEIGHT_DELTA_PX;
  const resizesContentOpen =
    bothShrunkTogether &&
    (input.editableFocused || visualOffsetTop > 0);
  const keyboardOpen = resizesVisualOpen || resizesContentOpen;

  if (!keyboardOpen) {
    return {
      heightPx: layoutHeight,
      keyboardMode: "closed",
      keyboardOpen: false,
      offsetTopPx: 0,
    };
  }

  return {
    heightPx: visualHeight,
    // Prefer the visual-only path when both signals could match. Safari keeps
    // layout tall; Chrome with resizes-content shrinks both together.
    keyboardMode: resizesVisualOpen ? "resizes-visual" : "resizes-content",
    keyboardOpen: true,
    offsetTopPx: visualOffsetTop,
  };
}

/** Next closed-keyboard resting height. Always track the current layout. */
export function nextRestingLayoutHeight(input: {
  keyboardOpen: boolean;
  layoutHeight: number;
  previousRestingLayoutHeight: number;
}): number {
  const layoutHeight = Math.max(0, Math.round(input.layoutHeight));
  if (input.keyboardOpen) {
    return Math.max(0, Math.round(input.previousRestingLayoutHeight));
  }
  // Closed: follow the current layout so orientation shrinks do not leave a
  // taller stale resting value that later looks like a keyboard.
  return layoutHeight;
}

/**
 * Keep Safari focus panning from moving the fixed workspace with the keyboard.
 *
 * Contract while an editor is focused and the keyboard is open:
 * 1. Always follow keyboard **resize** (height/offset animation).
 * 2. `resizes-visual` (Safari): accept the first significant non-resize offset
 *    while still undocked. iOS often delivers that first dock as scroll after a
 *    zero-offset resize. Tiny jitter below `MIN_FIRST_DOCK_OFFSET_PX` is ignored
 *    so it cannot lock out the real dock.
 * 3. `resizes-content` (Chrome meta): offset 0 is the steady open geometry.
 *    Freeze every non-resize source so caret pans cannot move the shell.
 * 4. Freeze later non-resize sources after the first real dock.
 *
 * After blur / closed keyboard, snap offset to 0 even if a stale visual offset
 * remains for a frame.
 */
export function mobileViewportOffsetTop(input: {
  editableFocused: boolean;
  keyboardMode: MobileViewportKeyboardMode;
  keyboardOpen: boolean;
  nextOffsetTop: number;
  previousOffsetTop: number;
  source: MobileViewportSyncSource;
}): number {
  if (input.editableFocused && input.keyboardOpen) {
    if (input.source === "resize") {
      return input.nextOffsetTop;
    }
    // Chrome resizes-content keeps offset at 0 while open. A later caret pan
    // must not be mistaken for an undocked first-dock handoff.
    if (input.keyboardMode === "resizes-content") {
      return input.previousOffsetTop;
    }
    // Safari resizes-visual first dock: height may open with offset 0, then
    // scroll/focus/measure reports the real visual top. Require a real dock
    // size so jitter cannot freeze the shell before the keyboard settles.
    if (
      input.previousOffsetTop === 0 &&
      input.nextOffsetTop >= MIN_FIRST_DOCK_OFFSET_PX
    ) {
      return input.nextOffsetTop;
    }
    return input.previousOffsetTop;
  }
  // After blur, snap closed-keyboard geometry back to the layout top even if a
  // stale visual offset is still reported for a frame.
  if (!input.keyboardOpen) return 0;
  return input.nextOffsetTop;
}

/** Keep the mobile workspace inside the visual viewport while the keyboard is open. */
export function useMobileViewportHeight(
  rootRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!enabled || !root || typeof window === "undefined") return;

    const mobile = window.matchMedia("(max-width: 767px)");
    const viewport = window.visualViewport;
    let frame: number | undefined;
    let pendingSource: MobileViewportSyncSource | undefined;
    let lastHeight = "";
    let lastOffsetTop = "";
    let lastKeyboardOpen = "";
    let lastDockPadding = "";
    let appliedOffsetTopPx = 0;
    let restingLayoutHeight = Math.round(window.innerHeight);
    let wasMobile = mobile.matches;
    let documentScrollLocked = false;

    // Share the dashboard body-scroll lock with drawers and the mobile nav
    // sheet so independent restore paths cannot leave overflow stuck hidden.
    const setDocumentScrollLocked = (locked: boolean) => {
      if (documentScrollLocked === locked) return;
      documentScrollLocked = locked;
      if (locked) {
        acquireBodyScrollLock();
        return;
      }
      releaseBodyScrollLock();
    };

    const clearViewportProperties = () => {
      if (lastHeight !== "") {
        root.style.removeProperty(viewportHeightProperty);
        lastHeight = "";
      }
      if (lastOffsetTop !== "") {
        root.style.removeProperty(viewportOffsetTopProperty);
        lastOffsetTop = "";
      }
      if (lastKeyboardOpen !== "") {
        root.style.removeProperty(keyboardOpenProperty);
        lastKeyboardOpen = "";
      }
      if (lastDockPadding !== "") {
        root.style.removeProperty(composerDockPaddingProperty);
        lastDockPadding = "";
      }
      appliedOffsetTopPx = 0;
    };

    const syncHeight = (source: MobileViewportSyncSource) => {
      pendingSource = coalescedMobileViewportSyncSource(pendingSource, source);
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        const syncSource = pendingSource ?? source;
        pendingSource = undefined;
        // Prefer visualViewport as the single geometry owner. Fall back to
        // layout height only when the browser has no visual viewport API.
        const layoutHeight = window.innerHeight;
        const visualHeight = viewport?.height ?? layoutHeight;
        const visualOffsetTop = viewport?.offsetTop ?? 0;
        const editableFocused = isEditableElement(document.activeElement);
        const isMobile = mobile.matches;
        if (!isMobile) {
          // Desktop: keep resting in lockstep with layout so a later mobile
          // breakpoint cannot compare against a tall stale desktop height.
          restingLayoutHeight = nextRestingLayoutHeight({
            keyboardOpen: false,
            layoutHeight,
            previousRestingLayoutHeight: restingLayoutHeight,
          });
          wasMobile = false;
          setDocumentScrollLocked(false);
          clearViewportProperties();
          frame = undefined;
          return;
        }
        if (!wasMobile) {
          // First mobile frame after desktop: baseline against current layout.
          restingLayoutHeight = Math.round(layoutHeight);
          wasMobile = true;
        }
        const metrics = mobileViewportMetrics({
          editableFocused,
          layoutHeight,
          mobile: true,
          restingLayoutHeight,
          visualHeight,
          visualOffsetTop,
        });

        if (!metrics) {
          setDocumentScrollLocked(false);
          clearViewportProperties();
          frame = undefined;
          return;
        }

        restingLayoutHeight = nextRestingLayoutHeight({
          keyboardOpen: metrics.keyboardOpen,
          layoutHeight,
          previousRestingLayoutHeight: restingLayoutHeight,
        });

        setDocumentScrollLocked(true);
        // Zero document scroll so iOS cannot leave the fixed shell above the
        // visual top after a focus pan.
        if (window.scrollY !== 0 || window.scrollX !== 0) {
          window.scrollTo(0, 0);
        }
        const offsetTopPx = mobileViewportOffsetTop({
          editableFocused,
          keyboardMode: metrics.keyboardMode,
          keyboardOpen: metrics.keyboardOpen,
          nextOffsetTop: metrics.offsetTopPx,
          previousOffsetTop: appliedOffsetTopPx,
          source: syncSource,
        });
        const nextHeight = `${metrics.heightPx}px`;
        const nextOffsetTop = `${offsetTopPx}px`;
        const nextKeyboardOpen = metrics.keyboardOpen ? "1" : "0";
        const nextDockPadding = COMPOSER_DOCK_PADDING;
        if (lastHeight !== nextHeight) {
          root.style.setProperty(viewportHeightProperty, nextHeight);
          lastHeight = nextHeight;
        }
        if (lastOffsetTop !== nextOffsetTop) {
          root.style.setProperty(viewportOffsetTopProperty, nextOffsetTop);
          lastOffsetTop = nextOffsetTop;
        }
        if (lastKeyboardOpen !== nextKeyboardOpen) {
          root.style.setProperty(keyboardOpenProperty, nextKeyboardOpen);
          lastKeyboardOpen = nextKeyboardOpen;
        }
        if (lastDockPadding !== nextDockPadding) {
          root.style.setProperty(composerDockPaddingProperty, nextDockPadding);
          lastDockPadding = nextDockPadding;
        }
        appliedOffsetTopPx = offsetTopPx;
        frame = undefined;
      });
    };

    const syncFromMeasure = () => syncHeight("measure");
    const syncFromResize = () => syncHeight("resize");
    const syncFromScroll = () => syncHeight("scroll");
    const syncFromFocusIn = () => syncHeight("focusin");
    const syncFromFocusOut = () => syncHeight("focusout");

    syncFromMeasure();
    mobile.addEventListener("change", syncFromMeasure);
    window.addEventListener("resize", syncFromResize);
    // Keyboard open arrives as resize (accept dock offset). Safari focus pans
    // arrive as scroll while focused (freeze so the shell does not chase).
    viewport?.addEventListener("resize", syncFromResize);
    viewport?.addEventListener("scroll", syncFromScroll);
    document.addEventListener("focusin", syncFromFocusIn);
    document.addEventListener("focusout", syncFromFocusOut);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      mobile.removeEventListener("change", syncFromMeasure);
      window.removeEventListener("resize", syncFromResize);
      viewport?.removeEventListener("resize", syncFromResize);
      viewport?.removeEventListener("scroll", syncFromScroll);
      document.removeEventListener("focusin", syncFromFocusIn);
      document.removeEventListener("focusout", syncFromFocusOut);
      setDocumentScrollLocked(false);
      clearViewportProperties();
    };
  }, [enabled, rootRef]);
}

function isEditableElement(element: Element | null): boolean {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLElement && element.isContentEditable)
  );
}
