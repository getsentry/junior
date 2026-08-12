import { useEffect, type RefObject } from "react";

const viewportHeightProperty = "--dashboard-viewport-height";

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
          root.style.setProperty(
            viewportHeightProperty,
            `${Math.round(viewport?.height ?? window.innerHeight)}px`,
          );
        } else {
          root.style.removeProperty(viewportHeightProperty);
        }
        frame = undefined;
      });
    };

    syncHeight();
    mobile.addEventListener("change", syncHeight);
    window.addEventListener("resize", syncHeight);
    viewport?.addEventListener("resize", syncHeight);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      mobile.removeEventListener("change", syncHeight);
      window.removeEventListener("resize", syncHeight);
      viewport?.removeEventListener("resize", syncHeight);
      root.style.removeProperty(viewportHeightProperty);
    };
  }, [enabled, rootRef]);
}
