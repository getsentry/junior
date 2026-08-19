import { useEffect, type RefObject } from "react";

const viewportHeightProperty = "--dashboard-viewport-height";
const viewportOffsetTopProperty = "--dashboard-viewport-offset-top";
const composerBottomPaddingProperty = "--dashboard-composer-bottom-padding";

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
    const syncHeight = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (mobile.matches) {
          const viewportHeight = viewport?.height ?? window.innerHeight;
          const viewportOffsetTop = viewport?.offsetTop ?? 0;
          root.style.setProperty(
            viewportHeightProperty,
            `${Math.round(viewportHeight)}px`,
          );
          root.style.setProperty(
            viewportOffsetTopProperty,
            `${Math.round(viewportOffsetTop)}px`,
          );
          const keyboardInset =
            window.innerHeight - viewportHeight - viewportOffsetTop;
          if (keyboardInset > 100) {
            root.style.setProperty(composerBottomPaddingProperty, "0px");
          } else {
            root.style.removeProperty(composerBottomPaddingProperty);
          }
        } else {
          root.style.removeProperty(viewportHeightProperty);
          root.style.removeProperty(viewportOffsetTopProperty);
          root.style.removeProperty(composerBottomPaddingProperty);
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
      root.style.removeProperty(viewportHeightProperty);
      root.style.removeProperty(viewportOffsetTopProperty);
      root.style.removeProperty(composerBottomPaddingProperty);
    };
  }, [enabled, rootRef]);
}
