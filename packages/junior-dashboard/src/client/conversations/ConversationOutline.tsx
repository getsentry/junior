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
const BAR_PX = { base: 6, active: 14, max: 18 };
/** Items within this distance of the pointer grow, the nearest the most. */
const GROW_RADIUS_ITEMS = 4;
/** Room above a selected message, so it does not touch the viewport edge. */
const JUMP_MARGIN_PX = 12;

/**
 * Show the person messages of a Conversation as a rail of bars beside the
 * transcript. The bar of the message being read is dark. Bars near the
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
  const activeSeq = useActiveOutlineSeq(items, scrollRef);
  // The pointer position over the outline, in items.
  const [pointer, setPointer] = useState<number>();
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

  // A long outline scrolls. Keep the active item in its view.
  const activeIndex = items.findIndex((item) => item.seq === activeSeq);
  useEffect(() => {
    const list = listRef.current;
    if (!list || activeIndex < 0 || pointer !== undefined) return;
    const top = activeIndex * ITEM_PX;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + ITEM_PX > list.scrollTop + list.clientHeight) {
      list.scrollTop = top + ITEM_PX - list.clientHeight;
    }
  }, [activeIndex, pointer]);

  const onPointerMove = (event: PointerEvent<HTMLOListElement>) => {
    const list = event.currentTarget;
    const y = event.clientY - list.getBoundingClientRect().top + list.scrollTop;
    setPointer(y / ITEM_PX - 0.5);
  };
  const clearPointer = () => setPointer(undefined);

  const previewIndex =
    pointer === undefined
      ? undefined
      : Math.min(items.length - 1, Math.max(0, Math.round(pointer)));
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
                aria-current={item.seq === activeSeq ? "location" : undefined}
                aria-label={item.title}
                className="flex w-5 cursor-pointer items-center border-0 bg-transparent p-0 focus-visible:outline focus-visible:outline-1 focus-visible:outline-dashboard-focus/55"
                onClick={() => {
                  props.onSelect(item.seq);
                  setJumpSeq(item.seq);
                }}
                onFocus={() => setPointer(index)}
                style={{ height: ITEM_PX }}
                type="button"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "h-0.5 rounded-full transition-[width,background-color] duration-150 ease-out motion-reduce:transition-none",
                    item.seq === activeSeq
                      ? "bg-dashboard-text-faint"
                      : index === previewIndex
                        ? "bg-dashboard-border-heavy"
                        : "bg-dashboard-border-emphasis",
                  )}
                  style={{
                    width: barWidth(index, pointer, item.seq === activeSeq),
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
      className="pointer-events-none absolute left-full ml-2 grid w-72 -translate-y-1/2 gap-1.5 rounded-xl border border-dashboard-border-emphasis bg-dashboard-surface-raised px-3.5 py-3 shadow-[0_8px_24px_rgba(0,0,0,0.12)]"
      style={{ top: props.top }}
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
