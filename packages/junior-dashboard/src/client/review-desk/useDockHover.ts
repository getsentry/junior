import { useCallback, useEffect, useRef, type PointerEvent } from "react";

import { dockFalloff } from "@dashboard/lib/dock";
import { useConversationDensity } from "../conversations/conversationDensity";

/**
 * The card under the pointer grows this much; its neighbors about half as
 * much. The list's side inset (`DOCK_GUTTER`) follows it.
 */
const DOCK_GROW = 0.02;

/**
 * The list's side inset: at least half of a grown card's extra width, so a
 * grown card never reaches the scroll area's edge. A percent padding reads
 * the scroll area's width, which is wider than any card.
 */
export const DOCK_GUTTER = `max(1.5rem, calc(${(DOCK_GROW / 2) * 100}% + 0.25rem))`;
const RADIUS_CARDS = 2;
const DOCK_MEDIA =
  "(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)";

/**
 * Scale the cards of a comfortable Inbox list near the pointer, like a dock.
 * Only `transform` changes, so no row moves, and an open card stays still.
 * Spread the handlers on the list that holds the cards.
 */
export function useDockHover() {
  const [density] = useConversationDensity();
  const on = density === "comfortable";
  const frame = useRef(0);
  const scaled = useRef(new Set<HTMLElement>());

  const reset = useCallback(() => {
    cancelAnimationFrame(frame.current);
    for (const card of scaled.current) {
      card.style.transform = "";
      card.style.willChange = "";
    }
    scaled.current.clear();
  }, []);
  // Compact rows and an unmounted list keep no scale.
  useEffect(() => reset, [on, reset]);

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (!on || event.pointerType !== "mouse") return;
      if (!window.matchMedia(DOCK_MEDIA).matches) return reset();
      const list = event.currentTarget;
      const y = event.clientY;
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => {
        const cards = [...list.children].filter(
          (child): child is HTMLElement => child instanceof HTMLLIElement,
        );
        // The pointer as a card position: 0 is the middle of the first card.
        let pointer: number | undefined;
        for (const [index, card] of cards.entries()) {
          const box = card.getBoundingClientRect();
          if (y > box.bottom) continue;
          const into = Math.max(0, (y - box.top) / box.height);
          pointer = index + into - 0.5;
          break;
        }
        for (const [index, card] of cards.entries()) {
          const grow =
            pointer === undefined || card.dataset.expanded !== undefined
              ? 0
              : dockFalloff(Math.abs(index - pointer), RADIUS_CARDS);
          if (grow === 0) {
            if (!scaled.current.delete(card)) continue;
            card.style.transform = "";
            card.style.willChange = "";
            continue;
          }
          card.style.transform = `scale(${(1 + DOCK_GROW * grow).toFixed(4)})`;
          card.style.willChange = "transform";
          scaled.current.add(card);
        }
      });
    },
    [on, reset],
  );

  // A press can open the card under it, which then holds still: clear the
  // scales, and the next move sets them again.
  return { onPointerDown: reset, onPointerLeave: reset, onPointerMove };
}
