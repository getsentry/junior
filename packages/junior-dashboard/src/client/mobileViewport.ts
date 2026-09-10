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
// Tight closed/open pad. Safe-area is intentionally omitted: with
// viewport-fit=cover + visualViewport shell docking, env(safe-area-inset-bottom)
// stacks a large home-indicator gap (and Safari often keeps it while the
// keyboard is open: https://bugs.webkit.org/show_bug.cgi?id=217754).
const COMPOSER_DOCK_PADDING = "0.375rem";

export type MobileViewportMetrics = {
  heightPx: number;
  keyboardOpen: boolean;
  offsetTopPx: number;
};

/**
 * Map layout + visual viewport into shell geometry.
 *
 * Contract:
 * - closed keyboard: shell = layout height, offset 0 (ignore rubber-band)
 * - open keyboard: shell height = visual height
 * - offset is only non-zero when layout stays tall and visual is shorter
 *   (classic Safari). When layout already matches the visible band
 *   (`interactive-widget=resizes-content`), offset stays 0 so the fixed shell
 *   cannot slide under the keyboard.
 *
 * No freeze / first-dock / source coalesce. The shell follows live geometry.
 * Body scroll lock stops document panning; the shell does not fight scrollY.
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
      keyboardOpen: false,
      offsetTopPx: 0,
    };
  }

  // Layout already owns the visible band: keep top at 0 even if visual still
  // reports a leftover offset (composer-under-keyboard failure mode).
  if (!resizesVisualOpen) {
    return {
      heightPx: visualHeight,
      keyboardOpen: true,
      offsetTopPx: 0,
    };
  }

  const maxOffsetTop = Math.max(0, layoutHeight - visualHeight);
  return {
    heightPx: visualHeight,
    keyboardOpen: true,
    offsetTopPx: Math.min(visualOffsetTop, maxOffsetTop),
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
    let lastHeight = "";
    let lastOffsetTop = "";
    let lastKeyboardOpen = "";
    let lastDockPadding = "";
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
    };

    const syncHeight = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
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

        // Body lock pins the document. Do not fight scrollY with scrollTo —
        // that snap loop is the input-drag vibration.
        setDocumentScrollLocked(true);
        const nextHeight = `${metrics.heightPx}px`;
        const nextOffsetTop = `${metrics.offsetTopPx}px`;
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
        frame = undefined;
      });
    };

    syncHeight();
    mobile.addEventListener("change", syncHeight);
    window.addEventListener("resize", syncHeight);
    viewport?.addEventListener("resize", syncHeight);
    viewport?.addEventListener("scroll", syncHeight);
    document.addEventListener("focusin", syncHeight);
    document.addEventListener("focusout", syncHeight);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      mobile.removeEventListener("change", syncHeight);
      window.removeEventListener("resize", syncHeight);
      viewport?.removeEventListener("resize", syncHeight);
      viewport?.removeEventListener("scroll", syncHeight);
      document.removeEventListener("focusin", syncHeight);
      document.removeEventListener("focusout", syncHeight);
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
