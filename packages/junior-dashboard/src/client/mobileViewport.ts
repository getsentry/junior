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

/** Keep Safari focus panning from moving the fixed workspace with the keyboard. */
export function mobileViewportOffsetTop(input: {
  editableFocused: boolean;
  nextOffsetTop: number;
  previousOffsetTop: number;
}): number {
  return input.editableFocused ? input.previousOffsetTop : input.nextOffsetTop;
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

    const syncHeight = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
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

    syncHeight();
    mobile.addEventListener("change", syncHeight);
    window.addEventListener("resize", syncHeight);
    // Keep height current during keyboard animation. Ignore Safari's focus pan
    // offset until focus leaves the editor, or the fixed shell chases the pan.
    viewport?.addEventListener("resize", syncHeight);
    viewport?.addEventListener("scroll", syncHeight);
    document.addEventListener("focusout", syncHeight);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      mobile.removeEventListener("change", syncHeight);
      window.removeEventListener("resize", syncHeight);
      viewport?.removeEventListener("resize", syncHeight);
      viewport?.removeEventListener("scroll", syncHeight);
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
