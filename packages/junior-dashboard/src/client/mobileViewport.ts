import { useEffect, type RefObject } from "react";

const viewportHeightProperty = "--dashboard-viewport-height";
const viewportOffsetTopProperty = "--dashboard-viewport-offset-top";

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
    let offsetTop = Math.round(viewport?.offsetTop ?? 0);
    const syncHeight = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (mobile.matches) {
          root.style.setProperty(
            viewportHeightProperty,
            `${Math.round(viewport?.height ?? window.innerHeight)}px`,
          );
          offsetTop = mobileViewportOffsetTop({
            editableFocused: isEditableElement(document.activeElement),
            nextOffsetTop: Math.round(viewport?.offsetTop ?? 0),
            previousOffsetTop: offsetTop,
          });
          root.style.setProperty(viewportOffsetTopProperty, `${offsetTop}px`);
        } else {
          root.style.removeProperty(viewportHeightProperty);
          root.style.removeProperty(viewportOffsetTopProperty);
        }
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
      root.style.removeProperty(viewportHeightProperty);
      root.style.removeProperty(viewportOffsetTopProperty);
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
