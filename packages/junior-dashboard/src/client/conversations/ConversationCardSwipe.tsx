import { useCallback, useRef, type RefObject, type TouchEvent } from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "../styles";

// A move this far settles a touch as a swipe or a scroll. The long press
// ends at the same move, so a swipe never also opens the row sheet.
const SWIPE_START_PX = 10;
// A release past this runs the action.
const SWIPE_COMMIT_PX = 96;
const SETTLE = "200ms ease-out";

type SwipeAction = {
  icon: LucideIcon;
  run(): void;
};

/**
 * Run a card action from a horizontal swipe on a touch screen. A swipe right
 * runs `leading` and a swipe left runs `trailing`. The card follows the
 * finger, and the action shows in the space that opens behind it. The swipe
 * writes styles to the card directly, so the card does not render on each
 * move.
 */
export function useCardSwipe(options: {
  leading?: SwipeAction | undefined;
  trailing?: SwipeAction | undefined;
}) {
  const cardRef = useRef<HTMLElement | null>(null);
  const setCardRef = useCallback((node: HTMLElement | null) => {
    cardRef.current = node;
  }, []);
  const leadingRef = useRef<HTMLDivElement>(null);
  const trailingRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<
    { axis?: "x" | "y"; offset: number; x: number; y: number } | undefined
  >(undefined);

  const paint = (offset: number, settle: boolean) => {
    const card = cardRef.current;
    if (!card) return;
    // Only a moved card can settle. A transition without a move never ends.
    const animate =
      settle &&
      card.style.transform !== "" &&
      !matchMedia("(prefers-reduced-motion: reduce)").matches;
    card.style.transition = animate ? `transform ${SETTLE}` : "none";
    card.style.transform = offset ? `translateX(${offset}px)` : "";
    // Give the card its own transitions back once it settles.
    if (animate) {
      card.addEventListener(
        "transitionend",
        () => (card.style.transition = ""),
        { once: true },
      );
    } else if (!offset) {
      card.style.transition = "";
    }
    const layers = [
      [leadingRef.current, Math.max(offset, 0)],
      [trailingRef.current, Math.max(-offset, 0)],
    ] as const;
    for (const [layer, width] of layers) {
      if (!layer) continue;
      layer.style.transition = animate ? `width ${SETTLE}` : "none";
      layer.style.width = `${width}px`;
      layer.toggleAttribute("data-armed", width >= SWIPE_COMMIT_PX);
    }
  };

  const end = (event: TouchEvent, run: boolean) => {
    const gesture = gestureRef.current;
    gestureRef.current = undefined;
    if (gesture?.axis !== "x") return;
    // The lift ends a swipe, not a tap on the card link.
    event.preventDefault();
    paint(0, true);
    if (!run) return;
    if (gesture.offset >= SWIPE_COMMIT_PX) options.leading?.run();
    if (gesture.offset <= -SWIPE_COMMIT_PX) options.trailing?.run();
  };

  const enabled = Boolean(options.leading ?? options.trailing);

  return {
    cardRef: setCardRef,
    enabled,
    leading: options.leading
      ? { action: options.leading, ref: leadingRef }
      : undefined,
    trailing: options.trailing
      ? { action: options.trailing, ref: trailingRef }
      : undefined,
    onTouchCancel: (event: TouchEvent) => end(event, false),
    onTouchEnd: (event: TouchEvent) => end(event, true),
    onTouchMove: (event: TouchEvent) => {
      const gesture = gestureRef.current;
      const touch = event.touches[0];
      if (!gesture || !touch) return;
      const dx = touch.clientX - gesture.x;
      const dy = touch.clientY - gesture.y;
      if (!gesture.axis) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) <= SWIPE_START_PX) return;
        gesture.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      }
      if (gesture.axis !== "x") return;
      const width = cardRef.current?.offsetWidth ?? 0;
      const action = dx > 0 ? options.leading : options.trailing;
      const offset = action ? Math.max(-width, Math.min(width, dx)) : 0;
      const armed = Math.abs(offset) >= SWIPE_COMMIT_PX;
      // Android buzzes once when a release would run the action.
      if (armed && Math.abs(gesture.offset) < SWIPE_COMMIT_PX) {
        if ("vibrate" in navigator) navigator.vibrate(10);
      }
      gesture.offset = offset;
      paint(offset, false);
    },
    onTouchStart: (event: TouchEvent) => {
      // A second finger ends the swipe, so the card goes back.
      if (gestureRef.current?.axis === "x") paint(0, true);
      const touch = event.touches[0];
      gestureRef.current =
        enabled && event.touches.length === 1 && touch
          ? { offset: 0, x: touch.clientX, y: touch.clientY }
          : undefined;
    },
  };
}

/** Show a swipe action in the space that opens beside the moving card. */
export function CardSwipeLayer(props: {
  action: SwipeAction;
  className: string;
  ref: RefObject<HTMLDivElement | null>;
  side: "leading" | "trailing";
}) {
  const Icon = props.action.icon;
  return (
    <div
      aria-hidden="true"
      className={cn(
        // A closed layer has no width, so it has no padding of its own.
        "group/swipe pointer-events-none absolute inset-y-0 flex w-0 items-center overflow-hidden rounded-lg",
        props.side === "leading"
          ? "left-0 justify-start"
          : "right-0 justify-end",
        props.className,
      )}
      ref={props.ref}
    >
      <Icon
        aria-hidden="true"
        className="mx-5 size-5 shrink-0 scale-75 opacity-60 transition-[scale,opacity] duration-150 group-data-armed/swipe:scale-100 group-data-armed/swipe:opacity-100"
      />
    </div>
  );
}
