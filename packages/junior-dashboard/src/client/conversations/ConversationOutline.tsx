import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
} from "react";

import { cn } from "../styles";
import {
  outlineItemAtSeq,
  type ConversationOutlineItem,
} from "./conversationOutlineItems";

/** Height of one item. The pointer maps to items with it. */
const ITEM_PX = 8;
/** Bar widths. Bars near the pointer grow from `base` toward `max`. */
const BAR_PX = { base: 6, active: 14, max: 24 };
/** Items within this distance of the pointer grow, the nearest the most. */
const GROW_RADIUS_ITEMS = 4;
/** Room above a selected message, so it does not touch the viewport edge. */
const JUMP_MARGIN_PX = 12;

/**
 * Show the person messages of a Conversation as a rail of bars beside the
 * transcript. The bar of the message being read stands out. Bars near the
 * pointer grow, and the pointed item shows a preview card. A click puts the
 * message at the top of the transcript viewport.
 *
 * `onSelect` must make the transcript mount the row of the seq, because the
 * transcript mounts only the rows near the viewport.
 */
export function ConversationOutline(props: {
  items: readonly ConversationOutlineItem[];
  onSelect(seq: number): void;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const { items, scrollRef } = props;
  const listRef = useRef<HTMLOListElement>(null);
  const barRefs = useRef<(HTMLSpanElement | null)[]>([]);
  // The pointer position over the outline, in items. Bars follow it on each
  // move, so it is not state: a move must not render every item.
  const pointerRef = useRef<number>(undefined);
  const activeSeq = useActiveOutlineSeq(items, scrollRef);
  const activeIndex = items.findIndex((item) => item.seq === activeSeq);
  const [previewIndex, setPreviewIndex] = useState<number>();
  const [jumpSeq, setJumpSeq] = useState<number>();

  useEffect(() => {
    if (jumpSeq === undefined) return;
    setJumpSeq(undefined);
    const scroll = scrollRef.current;
    const row = scroll?.querySelector(`[data-transcript-seq="${jumpSeq}"]`);
    if (!scroll || !row) return;
    scroll.scrollTop +=
      row.getBoundingClientRect().top -
      scroll.getBoundingClientRect().top -
      JUMP_MARGIN_PX;
  }, [jumpSeq, scrollRef]);

  // A long outline scrolls in proportion to the active item, so the active
  // bar moves through the rail and reaches its ends only with the transcript.
  useEffect(() => {
    const list = listRef.current;
    if (!list || activeIndex < 0 || previewIndex !== undefined) return;
    const overflow = list.scrollHeight - list.clientHeight;
    if (overflow <= 0) return;
    list.scrollTop = (overflow * activeIndex) / Math.max(1, items.length - 1);
  }, [activeIndex, items.length, previewIndex]);

  // Bars outside the grow radius keep their width.
  const movePointer = (pointer: number | undefined) => {
    const previous = pointerRef.current;
    pointerRef.current = pointer;
    const near = [previous, pointer].filter((value) => value !== undefined);
    if (near.length === 0) return;
    const from = Math.max(0, Math.floor(Math.min(...near) - GROW_RADIUS_ITEMS));
    const to = Math.min(
      items.length - 1,
      Math.ceil(Math.max(...near) + GROW_RADIUS_ITEMS),
    );
    for (let index = from; index <= to; index += 1) {
      const bar = barRefs.current[index];
      if (!bar) continue;
      bar.style.transform = barTransform(
        barWidth(index, pointer, index === activeIndex),
      );
    }
    setPreviewIndex(
      pointer === undefined
        ? undefined
        : Math.min(items.length - 1, Math.max(0, Math.round(pointer))),
    );
  };

  const onPointerMove = (event: PointerEvent<HTMLOListElement>) => {
    // A tap is not a hover.
    if (event.pointerType === "touch") return;
    const list = event.currentTarget;
    const y = event.clientY - list.getBoundingClientRect().top + list.scrollTop;
    movePointer(y / ITEM_PX - 0.5);
  };
  const clearPointer = () => movePointer(undefined);

  const preview = previewIndex === undefined ? undefined : items[previewIndex];
  const previewTop =
    previewIndex === undefined
      ? 0
      : previewIndex * ITEM_PX +
        ITEM_PX / 2 -
        (listRef.current?.scrollTop ?? 0);

  return (
    <nav
      aria-label="Conversation outline"
      className="pointer-events-none absolute inset-y-8 left-3 z-20 hidden items-center @min-[62rem]/chat:flex"
    >
      <div className="relative flex max-h-full flex-col">
        <ol
          className="pointer-events-auto m-0 min-h-0 list-none overflow-y-auto overscroll-contain p-0 pr-2 [scrollbar-width:none]"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) {
              clearPointer();
            }
          }}
          onPointerLeave={clearPointer}
          onPointerMove={onPointerMove}
          ref={listRef}
        >
          {items.map((item, index) => (
            <li key={item.seq}>
              <button
                aria-current={index === activeIndex ? "location" : undefined}
                aria-label={item.title}
                className="flex w-6 cursor-pointer items-center border-0 bg-transparent p-0 focus-visible:outline focus-visible:outline-1 focus-visible:outline-dashboard-focus/55"
                onClick={() => {
                  props.onSelect(item.seq);
                  setJumpSeq(item.seq);
                }}
                onFocus={() => movePointer(index)}
                style={{ height: ITEM_PX }}
                type="button"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    // Scale, not width, so a grow skips layout.
                    "block h-0.5 origin-left rounded-full transition-[transform,background-color] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-[background-color]",
                    index === activeIndex
                      ? "bg-dashboard-text-faint"
                      : index === previewIndex
                        ? "bg-dashboard-border-heavy"
                        : "bg-dashboard-border-emphasis",
                  )}
                  ref={(bar) => {
                    barRefs.current[index] = bar;
                  }}
                  // A render can move the active bar while the pointer is
                  // over the outline, so it sizes bars for the pointer too.
                  style={{
                    transform: barTransform(
                      barWidth(
                        index,
                        pointerRef.current,
                        index === activeIndex,
                      ),
                    ),
                    width: BAR_PX.max,
                  }}
                />
              </button>
            </li>
          ))}
        </ol>
        {preview ? (
          <OutlinePreviewCard item={preview} top={previewTop} />
        ) : null}
      </div>
    </nav>
  );
}

function OutlinePreviewCard(props: {
  item: ConversationOutlineItem;
  top: number;
}) {
  return (
    <div
      aria-hidden="true"
      // It glides between items, and grows in from the outline when it opens.
      className="pointer-events-none absolute top-0 left-full ml-2 grid w-72 origin-left gap-1.5 rounded-xl border border-dashboard-border-emphasis bg-dashboard-surface-raised px-3.5 py-3 shadow-[0_8px_24px_rgba(0,0,0,0.12)] transition-[translate,scale,opacity] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] starting:scale-[0.97] starting:opacity-0 motion-reduce:transition-[opacity] motion-reduce:starting:scale-100"
      style={{ translate: `0 calc(${props.top}px - 50%)` }}
    >
      <p className="m-0 truncate text-sm font-medium text-dashboard-text">
        {props.item.title}
      </p>
      {props.item.reply ? (
        <p className="m-0 line-clamp-3 text-sm leading-relaxed text-dashboard-text-faint">
          {props.item.reply}
        </p>
      ) : null}
    </div>
  );
}

/** Grow bars near the pointer, like a dock. The active bar stays long. */
function barWidth(
  index: number,
  pointer: number | undefined,
  active: boolean,
): number {
  const distance = pointer === undefined ? Infinity : Math.abs(index - pointer);
  const grow =
    distance < GROW_RADIUS_ITEMS
      ? (1 + Math.cos((Math.PI * distance) / GROW_RADIUS_ITEMS)) / 2
      : 0;
  const width = BAR_PX.base + (BAR_PX.max - BAR_PX.base) * grow;
  return active ? Math.max(BAR_PX.active, width) : width;
}

function barTransform(width: number): string {
  return `scaleX(${width / BAR_PX.max})`;
}

/**
 * Track the item whose section holds the top of the transcript viewport. The
 * transcript mounts only rows near the viewport, so this reads the seq of the
 * top mounted row, not the item rows themselves.
 */
function useActiveOutlineSeq(
  items: readonly ConversationOutlineItem[],
  scrollRef: RefObject<HTMLDivElement | null>,
): number | undefined {
  const [activeSeq, setActiveSeq] = useState<number>();
  const update = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const top = scroll.getBoundingClientRect().top + JUMP_MARGIN_PX;
    let topRowSeq: number | undefined;
    let topRowStart = Infinity;
    for (const row of scroll.querySelectorAll<HTMLElement>(
      "[data-transcript-seq]",
    )) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom <= top || rect.top >= topRowStart) continue;
      topRowStart = rect.top;
      topRowSeq = Number(row.dataset.transcriptSeq);
    }
    setActiveSeq(
      topRowSeq === undefined
        ? undefined
        : outlineItemAtSeq(items, topRowSeq)?.seq,
    );
  }, [items, scrollRef]);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    schedule();
    scroll.addEventListener("scroll", schedule, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      scroll.removeEventListener("scroll", schedule);
    };
  }, [scrollRef, update]);

  return activeSeq;
}
