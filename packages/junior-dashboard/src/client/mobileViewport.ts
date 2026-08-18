import { useEffect, type RefObject } from "react";

import { acquireBodyScrollLock, releaseBodyScrollLock } from "./bodyScrollLock";

const viewportHeightProperty = "--dashboard-viewport-height";
const viewportOffsetTopProperty = "--dashboard-viewport-offset-top";
// Ignore small visualViewport shrink from rubber-band and transient chrome.
// Real software keyboards reduce height by much more than this.
const KEYBOARD_OPEN_HEIGHT_DELTA_PX = 100;

export type MobileViewportMetrics = {
  heightPx: number;
  offsetTopPx: number;
};

export type MobileViewportSyncSource =
  | "focusout"
  | "measure"
  | "resize"
  | "scroll";

const mobileViewportSyncPriority: Record<MobileViewportSyncSource, number> = {
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
 * Only follow visualViewport offset/height while the keyboard is open so
 * rubber-band pans cannot move the fixed conversation shell.
 *
 * Focus-time Safari pan freezes while typing use `mobileViewportOffsetTop`
 * (from #1594). This helper owns the closed-keyboard rubber-band case.
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
      offsetTopPx: 0,
    };
  }

  return {
    heightPx: visualHeight,
    offsetTopPx: Math.max(0, Math.round(input.visualOffsetTop)),
  };
}

/**
 * Keep Safari focus panning from moving the fixed workspace with the keyboard.
 *
 * First focus opens the keyboard with a resize that may set a non-zero
 * offsetTop. Accept that dock so the composer stays on the visual bottom.
 * Freeze only scroll-driven pans while an editor is focused.
 */
export function mobileViewportOffsetTop(input: {
  editableFocused: boolean;
  nextOffsetTop: number;
  previousOffsetTop: number;
  source: MobileViewportSyncSource;
}): number {
  if (input.editableFocused && input.source === "scroll") {
    return input.previousOffsetTop;
  }
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
      appliedOffsetTopPx = 0;
    };

    const syncHeight = (source: MobileViewportSyncSource) => {
      pendingSource = coalescedMobileViewportSyncSource(pendingSource, source);
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        const syncSource = pendingSource ?? source;
        pendingSource = undefined;
        const metrics = mobileViewportMetrics({
          layoutHeight: window.innerHeight,
          mobile: mobile.matches,
          visualHeight: viewport?.height ?? window.innerHeight,
          visualOffsetTop: viewport?.offsetTop ?? 0,
        });

        if (!metrics) {
          setDocumentScrollLocked(false);
          clearViewportProperties();
          frame = undefined;
          return;
        }

        setDocumentScrollLocked(true);
        const offsetTopPx = mobileViewportOffsetTop({
          editableFocused: isEditableElement(document.activeElement),
          nextOffsetTop: metrics.offsetTopPx,
          previousOffsetTop: appliedOffsetTopPx,
          source: syncSource,
        });
        const nextHeight = `${metrics.heightPx}px`;
        const nextOffsetTop = `${offsetTopPx}px`;
        if (lastHeight !== nextHeight) {
          root.style.setProperty(viewportHeightProperty, nextHeight);
          lastHeight = nextHeight;
        }
        if (lastOffsetTop !== nextOffsetTop) {
          root.style.setProperty(viewportOffsetTopProperty, nextOffsetTop);
          lastOffsetTop = nextOffsetTop;
        }
        appliedOffsetTopPx = offsetTopPx;
        frame = undefined;
      });
    };

    const syncFromMeasure = () => syncHeight("measure");
    const syncFromResize = () => syncHeight("resize");
    const syncFromScroll = () => syncHeight("scroll");
    const syncFromFocusOut = () => syncHeight("focusout");

    syncFromMeasure();
    mobile.addEventListener("change", syncFromMeasure);
    window.addEventListener("resize", syncFromResize);
    // Keyboard open arrives as resize (accept dock offset). Safari focus pans
    // arrive as scroll while focused (freeze so the shell does not chase).
    viewport?.addEventListener("resize", syncFromResize);
    viewport?.addEventListener("scroll", syncFromScroll);
    document.addEventListener("focusout", syncFromFocusOut);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      mobile.removeEventListener("change", syncFromMeasure);
      window.removeEventListener("resize", syncFromResize);
      viewport?.removeEventListener("resize", syncFromResize);
      viewport?.removeEventListener("scroll", syncFromScroll);
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
