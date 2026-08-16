import { useEffect, type RefObject } from "react";

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
    const html = document.documentElement;
    const body = document.body;
    const previousHtmlOverflow = html.style.overflow;
    const previousBodyOverflow = body.style.overflow;
    const previousHtmlOverscroll = html.style.overscrollBehavior;
    const previousBodyOverscroll = body.style.overscrollBehavior;
    let frame: number | undefined;
    let lastHeight = "";
    let lastOffsetTop = "";
    let documentScrollLocked = false;

    const setDocumentScrollLocked = (locked: boolean) => {
      if (documentScrollLocked === locked) return;
      documentScrollLocked = locked;
      if (locked) {
        html.style.overflow = "hidden";
        body.style.overflow = "hidden";
        html.style.overscrollBehavior = "none";
        body.style.overscrollBehavior = "none";
        return;
      }
      html.style.overflow = previousHtmlOverflow;
      body.style.overflow = previousBodyOverflow;
      html.style.overscrollBehavior = previousHtmlOverscroll;
      body.style.overscrollBehavior = previousBodyOverscroll;
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
        const nextHeight = `${metrics.heightPx}px`;
        const nextOffsetTop = `${metrics.offsetTopPx}px`;
        if (lastHeight !== nextHeight) {
          root.style.setProperty(viewportHeightProperty, nextHeight);
          lastHeight = nextHeight;
        }
        if (lastOffsetTop !== nextOffsetTop) {
          root.style.setProperty(viewportOffsetTopProperty, nextOffsetTop);
          lastOffsetTop = nextOffsetTop;
        }
        frame = undefined;
      });
    };

    syncHeight();
    mobile.addEventListener("change", syncHeight);
    window.addEventListener("resize", syncHeight);
    // Mobile Safari pans the visual viewport with scroll events while the
    // keyboard is open, so offsetTop can change without a resize.
    viewport?.addEventListener("resize", syncHeight);
    viewport?.addEventListener("scroll", syncHeight);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      mobile.removeEventListener("change", syncHeight);
      window.removeEventListener("resize", syncHeight);
      viewport?.removeEventListener("resize", syncHeight);
      viewport?.removeEventListener("scroll", syncHeight);
      setDocumentScrollLocked(false);
      clearViewportProperties();
    };
  }, [enabled, rootRef]);
}
