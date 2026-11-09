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
import { cn } from "@dashboard/lib/utils";

/** Height of one item. The pointer maps to items with it. */
const ITEM_PX = 8;
/** Bar widths. Bars near the pointer grow from `base` toward `max`. */
const BAR_PX = { base: 6, active: 14, max: 24 };
/** Items within this distance of the pointer grow, the nearest the most. */
const GROW_RADIUS_ITEMS = 4;

type MessageOutlineContextValue = {
  activeIndex: number;
  listRef: RefObject<HTMLOListElement | null>;
  movePointer(pointer: number | undefined): void;
  pointerRef: RefObject<number | undefined>;
  previewIndex: number | undefined;
  registerBar(index: number, bar: HTMLSpanElement | null): void;
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
 */
function MessageOutline({
  activeIndex,
  children,
  className,
  itemCount,
  ...props
}: ComponentProps<"nav"> & { activeIndex: number; itemCount: number }) {
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
      listRef,
      movePointer,
      pointerRef,
      previewIndex,
      registerBar: (index, bar) => {
        barRefs.current[index] = bar;
      },
    };
  }, [activeIndex, itemCount, previewIndex]);

  return (
    <MessageOutlineContext.Provider value={context}>
      <nav
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
  const { activeIndex, listRef, movePointer, previewIndex } =
    useMessageOutline();

  useEffect(() => {
    const list = listRef.current;
    if (!list || activeIndex < 0 || previewIndex !== undefined) return;
    const top = activeIndex * ITEM_PX;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + ITEM_PX > list.scrollTop + list.clientHeight) {
      list.scrollTop = top + ITEM_PX - list.clientHeight;
    }
  }, [activeIndex, listRef, previewIndex]);

  const onPointerMove = (event: PointerEvent<HTMLOListElement>) => {
    // A tap is not a hover.
    if (event.pointerType === "touch") return;
    const list = event.currentTarget;
    const y = event.clientY - list.getBoundingClientRect().top + list.scrollTop;
    movePointer(y / ITEM_PX - 0.5);
  };

  return (
    <ol
      data-slot="message-outline-list"
      className={cn(
        "pointer-events-auto m-0 min-h-0 list-none overflow-y-auto overscroll-contain p-0 pr-2 [scrollbar-width:none]",
        className,
      )}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          movePointer(undefined);
        }
      }}
      onPointerLeave={() => movePointer(undefined)}
      onPointerMove={onPointerMove}
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
  const { activeIndex, movePointer, pointerRef, previewIndex, registerBar } =
    useMessageOutline();
  const active = index === activeIndex;
  return (
    <li data-slot="message-outline-item">
      <button
        aria-current={active ? "location" : undefined}
        data-highlighted={!active && index === previewIndex ? "" : undefined}
        className={cn(
          "group/message-outline-item flex h-2 w-6 cursor-pointer items-center border-0 bg-transparent p-0 focus-visible:outline focus-visible:outline-1 focus-visible:outline-dashboard-focus/55",
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
            "block h-0.5 origin-left rounded-full bg-dashboard-border-emphasis transition-[transform,background-color] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-[background-color] group-data-highlighted/message-outline-item:bg-dashboard-border-heavy",
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
  const { listRef, previewIndex } = useMessageOutline();
  if (previewIndex === undefined) return null;
  const offset =
    previewIndex * ITEM_PX + ITEM_PX / 2 - (listRef.current?.scrollTop ?? 0);
  return (
    <div
      aria-hidden="true"
      data-slot="message-outline-preview"
      // It glides between items, and grows in from the rail when it opens.
      className={cn(
        "pointer-events-none absolute top-0 left-full ml-2 grid w-72 origin-left gap-1.5 rounded-xl border border-dashboard-border-emphasis bg-dashboard-surface-raised px-3.5 py-3 shadow-[0_8px_24px_rgba(0,0,0,0.12)] transition-[translate,scale,opacity] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] starting:scale-[0.97] starting:opacity-0 motion-reduce:transition-[opacity] motion-reduce:starting:scale-100",
        className,
      )}
      style={{ translate: `0 calc(${offset}px - 50%)` }}
      {...props}
    />
  );
}

/**
 * Name the previewed message in one line. With no description, it shows as
 * much of the message as a title and a description hold, so the preview
 * keeps its height as it glides between items.
 */
function MessageOutlinePreviewTitle({
  className,
  ...props
}: ComponentProps<"p">) {
  return (
    <p
      data-slot="message-outline-preview-title"
      className={cn(
        "m-0 truncate text-sm font-medium text-dashboard-text",
        // One title line, the gap, and three description lines.
        "only:min-h-[calc(var(--text-sm)*(var(--text-sm--line-height)+3*var(--leading-relaxed))+--spacing(1.5))] only:line-clamp-4 only:leading-relaxed only:whitespace-normal",
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

export {
  MessageOutline,
  MessageOutlineItem,
  MessageOutlineList,
  MessageOutlinePreview,
  MessageOutlinePreviewDescription,
  MessageOutlinePreviewTitle,
  useMessageOutline,
};
