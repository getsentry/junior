import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type PointerEvent,
  type RefObject,
} from "react";
import { dockFalloff } from "@dashboard/lib/dock";
import { cn } from "@dashboard/lib/utils";

/**
 * Height of one item. The pointer maps to items with it, so items use this
 * pixel height, not rem: rem changes with the browser font size.
 */
const ITEM_PX = 8;
/** Bar widths. Bars near the pointer grow from `base` toward `max`. */
const BAR_PX = { base: 6, active: 14, max: 24 };
/** Items within this distance of the pointer grow, the nearest the most. */
const GROW_RADIUS_ITEMS = 4;
/** A press must move this far before it drags, so a click stays a click. */
const DRAG_START_PX = 4;

/** The first and last index of the items on screen, like a scrollbar thumb. */
type MessageOutlineRange = { from: number; to: number };

/** The edge of the content that the rail sits on. */
type MessageOutlineSide = "left" | "right";

type MessageOutlineContextValue = {
  activeIndex: number;
  inView: MessageOutlineRange | undefined;
  itemCount: number;
  listRef: RefObject<HTMLOListElement | null>;
  movePointer(pointer: number | undefined): void;
  onScrub: ((index: number) => void) | undefined;
  pointerRef: RefObject<number | undefined>;
  previewIndex: number | undefined;
  registerBar(index: number, bar: HTMLSpanElement | null): void;
  side: MessageOutlineSide;
};

const MessageOutlineContext = createContext<
  MessageOutlineContextValue | undefined
>(undefined);

/** Read the outline state, such as the item that shows a preview. */
function useMessageOutline(): MessageOutlineContextValue {
  const context = useContext(MessageOutlineContext);
  if (!context) {
    throw new Error("useMessageOutline must be used within MessageOutline.");
  }
  return context;
}

/**
 * Frame a rail of message bars. The bar at `activeIndex` stands out. Bars
 * near the pointer grow like a dock, and the pointed item shows a preview.
 * Only the list takes the pointer, so the rail can lie over content.
 *
 * To stand in for a scrollbar, `inView` marks the items on screen like a
 * thumb, and `onScrub` gets the item under a press that drags along the list.
 * On the `right` side, bars grow to the left and the preview opens to the
 * left.
 */
function MessageOutline({
  activeIndex,
  children,
  className,
  inView,
  itemCount,
  onScrub,
  side = "left",
  ...props
}: ComponentProps<"nav"> & {
  activeIndex: number;
  inView?: MessageOutlineRange | undefined;
  itemCount: number;
  onScrub?: ((index: number) => void) | undefined;
  side?: MessageOutlineSide;
}) {
  const listRef = useRef<HTMLOListElement>(null);
  const barRefs = useRef<(HTMLSpanElement | null)[]>([]);
  // The pointer position over the list, in items. Bars follow it on each
  // move, so it is not state: a move must not render every item.
  const pointerRef = useRef<number>(undefined);
  const [previewIndex, setPreviewIndex] = useState<number>();

  const context = useMemo<MessageOutlineContextValue>(() => {
    // Bars outside the grow radius keep their width.
    const movePointer = (pointer: number | undefined) => {
      const previous = pointerRef.current;
      pointerRef.current = pointer;
      const near = [previous, pointer].filter((value) => value !== undefined);
      if (near.length === 0) return;
      const from = Math.max(
        0,
        Math.floor(Math.min(...near) - GROW_RADIUS_ITEMS),
      );
      const to = Math.min(
        itemCount - 1,
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
          : Math.min(itemCount - 1, Math.max(0, Math.round(pointer))),
      );
    };
    return {
      activeIndex,
      inView,
      itemCount,
      listRef,
      movePointer,
      onScrub,
      pointerRef,
      previewIndex,
      registerBar: (index, bar) => {
        barRefs.current[index] = bar;
      },
      side,
    };
  }, [activeIndex, inView, itemCount, onScrub, previewIndex, side]);

  return (
    <MessageOutlineContext.Provider value={context}>
      <nav
        data-side={side}
        data-slot="message-outline"
        className={cn("pointer-events-none flex items-center", className)}
        {...props}
      >
        <div className="relative flex max-h-full flex-col">{children}</div>
      </nav>
    </MessageOutlineContext.Provider>
  );
}

/**
 * Hold the outline items. A long list scrolls and keeps the active item in
 * its view while the pointer is away.
 */
function MessageOutlineList({ className, ...props }: ComponentProps<"ol">) {
  const {
    activeIndex,
    itemCount,
    listRef,
    movePointer,
    onScrub,
    previewIndex,
    side,
  } = useMessageOutline();

  useEffect(() => {
    const list = listRef.current;
    if (!list || activeIndex < 0 || previewIndex !== undefined) return;
    const top = activeIndex * ITEM_PX;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + ITEM_PX > list.scrollTop + list.clientHeight) {
      list.scrollTop = top + ITEM_PX - list.clientHeight;
    }
  }, [activeIndex, listRef, previewIndex]);

  // A wheel scrolls the items under a still pointer without a pointer
  // move, so a scroll points again from the last pointer position.
  const pointerYRef = useRef<number>(undefined);
  const pointAt = (list: HTMLOListElement, clientY: number) => {
    pointerYRef.current = clientY;
    const y = clientY - list.getBoundingClientRect().top + list.scrollTop;
    movePointer(y / ITEM_PX - 0.5);
  };
  const onPointerMove = (event: PointerEvent<HTMLOListElement>) => {
    // A tap is not a hover.
    if (event.pointerType === "touch") return;
    pointAt(event.currentTarget, event.clientY);
    scrub(event);
  };

  // A press that drags scrubs: it picks the item under the pointer, like a
  // scrollbar thumb. Touch keeps scrolling the list instead.
  const dragRef = useRef<{
    dragging: boolean;
    index?: number;
    pointerId: number;
    startY: number;
  }>(undefined);
  const scrub = (event: PointerEvent<HTMLOListElement>) => {
    const drag = dragRef.current;
    if (!onScrub || drag?.pointerId !== event.pointerId) return;
    // A release outside the list before the drag starts sends no
    // `pointerup` here, so a move without the button ends the press.
    if ((event.buttons & 1) === 0) {
      dragRef.current = undefined;
      return;
    }
    const list = event.currentTarget;
    if (!drag.dragging) {
      if (Math.abs(event.clientY - drag.startY) < DRAG_START_PX) return;
      drag.dragging = true;
      // The list keeps the pointer outside its box, and the click that
      // ends the drag goes to the list, not to an item.
      list.setPointerCapture(event.pointerId);
    }
    // Past an end, the list scrolls by the distance, so a drag reaches
    // items that the list does not show.
    const rect = list.getBoundingClientRect();
    if (event.clientY < rect.top) list.scrollTop -= rect.top - event.clientY;
    if (event.clientY > rect.bottom) {
      list.scrollTop += event.clientY - rect.bottom;
    }
    const y =
      Math.min(Math.max(event.clientY, rect.top), rect.bottom - 1) -
      rect.top +
      list.scrollTop;
    const index = Math.min(itemCount - 1, Math.floor(y / ITEM_PX));
    if (index === drag.index) return;
    drag.index = index;
    onScrub(index);
  };
  const endDrag = () => {
    dragRef.current = undefined;
  };

  return (
    <ol
      data-slot="message-outline-list"
      className={cn(
        "pointer-events-auto m-0 min-h-0 list-none overflow-y-auto overscroll-contain p-0 [scrollbar-width:none]",
        // The padding keeps the bars off the content beside the rail.
        side === "left" ? "pr-2" : "pl-2",
        className,
      )}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          movePointer(undefined);
        }
      }}
      onFocus={(event) => {
        // Keyboard focus points at its item until the pointer moves, so
        // the scroll that shows the item does not point at the pointer.
        if (event.target.matches(":focus-visible")) {
          pointerYRef.current = undefined;
        }
      }}
      onLostPointerCapture={endDrag}
      onPointerCancel={endDrag}
      onPointerDown={(event) => {
        if (!onScrub || event.button !== 0 || event.pointerType === "touch") {
          return;
        }
        dragRef.current = {
          dragging: false,
          pointerId: event.pointerId,
          startY: event.clientY,
        };
      }}
      onPointerLeave={() => {
        pointerYRef.current = undefined;
        movePointer(undefined);
      }}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onScroll={(event) => {
        if (pointerYRef.current !== undefined) {
          pointAt(event.currentTarget, pointerYRef.current);
        }
      }}
      ref={listRef}
      {...props}
    />
  );
}

/** Show one message as a bar. Give it an `aria-label` with the message text. */
function MessageOutlineItem({
  className,
  index,
  ...props
}: Omit<ComponentProps<"button">, "children"> & { index: number }) {
  const {
    activeIndex,
    inView,
    movePointer,
    pointerRef,
    previewIndex,
    registerBar,
    side,
  } = useMessageOutline();
  const active = index === activeIndex;
  const shown = inView && index >= inView.from && index <= inView.to;
  return (
    <li data-slot="message-outline-item">
      <button
        aria-current={active ? "location" : undefined}
        data-highlighted={!active && index === previewIndex ? "" : undefined}
        data-in-view={shown ? "" : undefined}
        className={cn(
          "group/message-outline-item flex h-[8px] w-6 cursor-pointer items-center border-0 bg-transparent p-0 focus-visible:outline focus-visible:outline-1 focus-visible:outline-ring/55",
          // The bar sits on the edge that the rail sits on, since `w-6`
          // and the bar's px width differ when the root font size does.
          side === "right" && "justify-end",
          // The items on screen join into one thumb.
          shown && "bg-dashboard-scrollbar-thumb",
          shown && index === inView.from && "rounded-t-sm",
          shown && index === inView.to && "rounded-b-sm",
          className,
        )}
        onFocus={() => movePointer(index)}
        type="button"
        {...props}
      >
        <span
          aria-hidden="true"
          data-slot="message-outline-bar"
          className={cn(
            // Scale, not width, so a grow skips layout.
            "block h-0.5 rounded-full bg-input transition-[transform,background-color] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-[background-color] group-data-highlighted/message-outline-item:bg-dashboard-border-heavy",
            // Bars grow away from the edge that the rail sits on.
            side === "left" ? "origin-left" : "origin-right",
            active && "bg-dashboard-text-faint",
          )}
          ref={(bar) => registerBar(index, bar)}
          // A render can move the active bar while the pointer is over the
          // list, so it sizes bars for the pointer too.
          style={{
            transform: barTransform(
              barWidth(index, pointerRef.current, active),
            ),
            width: BAR_PX.max,
          }}
        />
      </button>
    </li>
  );
}

/** Show a card beside the pointed item. It renders nothing without one. */
function MessageOutlinePreview({ className, ...props }: ComponentProps<"div">) {
  const { listRef, previewIndex, side } = useMessageOutline();
  if (previewIndex === undefined) return null;
  const list = listRef.current;
  const offset = previewIndex * ITEM_PX + ITEM_PX / 2 - (list?.scrollTop ?? 0);
  // The card centers on its item but stays inside the outline, so a card at
  // the first or last item does not make the page around it scroll.
  const wrapper = list?.offsetParent;
  let translate = `calc(${offset}px - 50%)`;
  if (wrapper instanceof HTMLElement && wrapper.parentElement) {
    const top = -wrapper.offsetTop;
    const bottom = top + wrapper.parentElement.clientHeight;
    translate = `clamp(${top}px, ${translate}, calc(${bottom}px - 100%))`;
  }
  return (
    <div
      aria-hidden="true"
      data-slot="message-outline-preview"
      // It glides between items, and grows in from the rail when it opens.
      className={cn(
        // It opens toward the content, away from the edge.
        side === "left"
          ? "left-full ml-2 origin-left"
          : "right-full mr-2 origin-right",
        "pointer-events-none absolute top-0 grid w-96 gap-1.5 rounded-xl border border-input bg-secondary px-3.5 py-3 shadow-[0_8px_24px_rgba(0,0,0,0.12)] transition-[translate,scale,opacity] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] starting:scale-[0.97] starting:opacity-0 motion-reduce:transition-[opacity] motion-reduce:starting:scale-100",
        className,
      )}
      style={{ translate: `0 ${translate}` }}
      {...props}
    />
  );
}

/**
 * Show the previewed message in two lines. With no description after it, it
 * shows as much of the message as a title and a description hold, so the
 * preview keeps its height as it glides between items.
 */
function MessageOutlinePreviewTitle({
  className,
  ...props
}: ComponentProps<"p">) {
  return (
    <p
      data-slot="message-outline-preview-title"
      className={cn(
        "m-0 line-clamp-2 text-sm font-medium text-foreground",
        // Two title lines, the gap, and three description lines.
        "last:min-h-[calc(var(--text-sm)*(2*var(--text-sm--line-height)+3*var(--leading-relaxed))+--spacing(1.5))] last:line-clamp-5 last:leading-relaxed",
        className,
      )}
      {...props}
    />
  );
}

/** Show who sent the previewed message and when, above its title. */
function MessageOutlinePreviewMeta({
  className,
  ...props
}: ComponentProps<"p">) {
  return (
    <p
      data-slot="message-outline-preview-meta"
      className={cn(
        "m-0 truncate text-xs text-dashboard-text-faint",
        className,
      )}
      {...props}
    />
  );
}

/** Show the start of the reply to the previewed message. */
function MessageOutlinePreviewDescription({
  className,
  ...props
}: ComponentProps<"p">) {
  return (
    <p
      data-slot="message-outline-preview-description"
      className={cn(
        "m-0 line-clamp-3 text-sm leading-relaxed text-dashboard-text-faint",
        className,
      )}
      {...props}
    />
  );
}

/** Grow bars near the pointer, like a dock. The active bar stays long. */
function barWidth(
  index: number,
  pointer: number | undefined,
  active: boolean,
): number {
  const distance = pointer === undefined ? Infinity : Math.abs(index - pointer);
  const grow = dockFalloff(distance, GROW_RADIUS_ITEMS);
  const width = BAR_PX.base + (BAR_PX.max - BAR_PX.base) * grow;
  return active ? Math.max(BAR_PX.active, width) : width;
}

function barTransform(width: number): string {
  return `scaleX(${width / BAR_PX.max})`;
}

export {
  MessageOutline,
  MessageOutlineItem,
  MessageOutlineList,
  MessageOutlinePreview,
  MessageOutlinePreviewDescription,
  MessageOutlinePreviewMeta,
  MessageOutlinePreviewTitle,
  useMessageOutline,
};
