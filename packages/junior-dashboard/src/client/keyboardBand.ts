import { useEffect, useState, type CSSProperties } from "react";

import { MOBILE_LAYOUT_QUERY } from "./layoutMedia";
import {
  isEditableElement,
  mobileViewportMetrics,
  nextRestingLayoutHeight,
  type MobileViewportMetrics,
} from "./mobileViewport";

// Only sheets that load on demand import this module, so the keyboard band
// stays out of the first load.

/**
 * Place a fixed sheet in the band above an open touch keyboard, so the
 * field in focus stays in view. A sheet that fills the band, such as a
 * tall sheet, takes its full height. A sheet that fits its content ends
 * at the keyboard's top edge. Without a band, the sheet keeps its own
 * place.
 */
export function keyboardBandStyle(
  band: MobileViewportMetrics | undefined,
  fill = true,
): CSSProperties | undefined {
  if (!band) return undefined;
  const height = `${band.heightPx}px`;
  if (fill) {
    return {
      bottom: "auto",
      height,
      maxHeight: height,
      top: `${band.offsetTopPx}px`,
    };
  }
  // The top edge goes to the keyboard, and `translate` lifts the sheet by
  // its own height. The drawer moves the sheet with `transform`, which
  // adds to `translate`.
  return {
    bottom: "auto",
    maxHeight: height,
    top: `${band.offsetTopPx + band.heightPx}px`,
    translate: "0 -100%",
  };
}

/**
 * The visible band above an open touch keyboard, or undefined while no
 * keyboard is open. A sheet that portals outside the shell reads it, so its
 * fields stay above the keyboard. It uses the same geometry as the shell
 * (`mobileViewportMetrics`) and writes no CSS variables.
 */
export function useKeyboardBand(): MobileViewportMetrics | undefined {
  const [band, setBand] = useState<MobileViewportMetrics>();
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const mobile = window.matchMedia(MOBILE_LAYOUT_QUERY);
    let restingLayoutHeight = Math.round(window.innerHeight);
    let frame: number | undefined;
    const sync = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        const layoutHeight = window.innerHeight;
        const metrics = mobileViewportMetrics({
          documentClientHeight:
            document.documentElement.clientHeight || layoutHeight,
          editableFocused: isEditableElement(document.activeElement),
          layoutHeight,
          mobile: mobile.matches,
          restingLayoutHeight,
          visualHeight: viewport.height,
          visualOffsetTop: viewport.offsetTop,
        });
        restingLayoutHeight = nextRestingLayoutHeight({
          keyboardOpen: metrics?.keyboardOpen ?? false,
          layoutHeight,
          previousRestingLayoutHeight: restingLayoutHeight,
        });
        const next = metrics?.keyboardOpen ? metrics : undefined;
        setBand((current) =>
          current?.heightPx === next?.heightPx &&
          current?.offsetTopPx === next?.offsetTopPx
            ? current
            : next,
        );
      });
    };
    sync();
    window.addEventListener("resize", sync);
    viewport.addEventListener("resize", sync);
    viewport.addEventListener("scroll", sync);
    document.addEventListener("focusin", sync);
    document.addEventListener("focusout", sync);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      window.removeEventListener("resize", sync);
      viewport.removeEventListener("resize", sync);
      viewport.removeEventListener("scroll", sync);
      document.removeEventListener("focusin", sync);
      document.removeEventListener("focusout", sync);
    };
  }, []);
  return band;
}
