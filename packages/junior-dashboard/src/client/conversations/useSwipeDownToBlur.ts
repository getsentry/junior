import { type RefObject, useEffect } from "react";

/** Downward finger travel that puts the keyboard away. */
const BLUR_SWIPE_PX = 24;

/**
 * Blur a focused field when a one-finger touch that starts outside it swipes
 * down, so mobile readers can put the keyboard away as in native chat apps.
 * Touches inside the field keep focus for text selection and scrolling.
 */
export function useSwipeDownToBlur(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    let start: { x: number; y: number } | undefined;
    const onTouchStart = (event: TouchEvent) => {
      const field = ref.current;
      const touch = event.touches[0];
      start =
        field &&
        touch &&
        event.touches.length === 1 &&
        document.activeElement === field &&
        !field.contains(event.target as Node)
          ? { x: touch.clientX, y: touch.clientY }
          : undefined;
    };
    const onTouchMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!start || !touch) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (dy < BLUR_SWIPE_PX || dy < Math.abs(dx)) return;
      start = undefined;
      ref.current?.blur();
    };
    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
    };
  }, [ref]);
}
