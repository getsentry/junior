import { useEffect, type RefObject } from "react";

import { acquireBodyScrollLock, releaseBodyScrollLock } from "./bodyScrollLock";

const viewportHeightProperty = "--dashboard-viewport-height";
const viewportOffsetTopProperty = "--dashboard-viewport-offset-top";
const keyboardOpenProperty = "--dashboard-keyboard-open";
// Ignore small visualViewport shrink from rubber-band and transient chrome.
// Real software keyboards reduce height by much more than this.
const KEYBOARD_OPEN_HEIGHT_DELTA_PX = 100;

export type MobileViewportMetrics = {
  heightPx: number;
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
 * Focus-time Safari pan freezes while typing use `mobileViewportOffsetTop`.
 */
export function mobileViewportMetrics(input: {
  layoutHeight: number;
  mobile: boolean;
  visualHeight: number;
  visualOffsetTop: number;
}): MobileViewportMetrics | null {
  if (!input.mobile) return null;

  const layoutHeight = Math.max(0, Math.round(input.layoutHeight));
  const visualHeight = Math.max(0, Math.round(input.visualHeight));
  const keyboardOpen =
    layoutHeight - visualHeight >= KEYBOARD_OPEN_HEIGHT_DELTA_PX;

  if (!keyboardOpen) {
    return {
      heightPx: layoutHeight,
      keyboardOpen: false,
      offsetTopPx: 0,
    };
  }

  return {
    heightPx: visualHeight,
    keyboardOpen: true,
    offsetTopPx: Math.max(0, Math.round(input.visualOffsetTop)),
  };
}

/**
 * Keep Safari focus panning from moving the fixed workspace with the keyboard.
 *
 * First focus opens the keyboard with a resize that may set a non-zero
 * offsetTop. Accept only resize docks while focused so the composer stays on
 * the visual bottom. Freeze every other source (scroll pans, focus churn,
 * measure) so the shell does not chase the caret.
 */
export function mobileViewportOffsetTop(input: {
  editableFocused: boolean;
  keyboardOpen: boolean;
  nextOffsetTop: number;
  previousOffsetTop: number;
  source: MobileViewportSyncSource;
}): number {
  // While an editor is focused, only keyboard resize may move the shell.
  // Scroll pans, focus churn, and measure must not chase the caret.
  if (input.editableFocused && input.source !== "resize") {
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
    let appliedOffsetTopPx = 0;
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
        const metrics = mobileViewportMetrics({
          layoutHeight,
          mobile: mobile.matches,
          visualHeight,
          visualOffsetTop,
        });

        if (!metrics) {
          setDocumentScrollLocked(false);
          clearViewportProperties();
          frame = undefined;
          return;
        }

        setDocumentScrollLocked(true);
        // Zero document scroll so iOS cannot leave the fixed shell above the
        // visual top after a focus pan.
        if (window.scrollY !== 0 || window.scrollX !== 0) {
          window.scrollTo(0, 0);
        }
        const offsetTopPx = mobileViewportOffsetTop({
          editableFocused: isEditableElement(document.activeElement),
          keyboardOpen: metrics.keyboardOpen,
          nextOffsetTop: metrics.offsetTopPx,
          previousOffsetTop: appliedOffsetTopPx,
          source: syncSource,
        });
        const nextHeight = `${metrics.heightPx}px`;
        const nextOffsetTop = `${offsetTopPx}px`;
        const nextKeyboardOpen = metrics.keyboardOpen ? "1" : "0";
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
