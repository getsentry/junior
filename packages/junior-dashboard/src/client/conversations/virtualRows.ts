import {
  defaultRangeExtractor,
  measureElement,
  useVirtualizer,
  type Range,
  type Virtualizer,
} from "@tanstack/react-virtual";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type Key,
  type RefObject,
} from "react";

import { scrollRootFor } from "./transcriptBottomPinning";

/** Rows mounted beyond the viewport on each side. */
const OVERSCAN_ROWS = 10;

/**
 * Pick and measure the rows of a list near the viewport of its scroll root.
 * The transcript scroll owner holds the reader's place, so this never moves
 * the scroll position. Rows at `keptIndexes` stay mounted outside the
 * viewport, so code that finds them in the DOM keeps working.
 *
 * A row that mounts above the reader with a size other than its estimate
 * moves what they read, and the scroll owner corrects that with a scroll.
 * Phones show such corrections as jumps, so a row's estimate is the mean
 * size of the measured rows of its `sizeClass`, which is close for rows of
 * one kind. `defaultSize` covers a class before any of its rows measure.
 *
 * Callers place each row at `start - options.scrollMargin` with
 * `measureElement` as its ref, inside a list that is `getTotalSize()` tall.
 */
export function useVirtualRows(input: {
  count: number;
  defaultSize: (sizeClass: string) => number;
  gap?: number;
  getItemKey: (index: number) => Key;
  keptIndexes: readonly (number | undefined)[];
  listRef: RefObject<HTMLElement | null>;
  sizeClass: (index: number) => string;
}) {
  const { listRef } = input;
  // The virtualizer reads estimates only for rows without a measured size.
  const sizes = useRef(new Map<string, { count: number; total: number }>());
  const rowSizes = useRef(new Map<Key, { size: number; sizeClass: string }>());
  // The estimate that each unmeasured row has now, by row key.
  const estimates = useRef(new Map<Key, number>());
  const rowInput = useRef(input);
  rowInput.current = input;
  const estimateSize = useCallback((index: number) => {
    const key = rowInput.current.getItemKey(index);
    // The virtualizer keeps a measurement only when it differs from the
    // row's estimate. A row that measured at its estimate would take a new
    // estimate after the next scroll, and the rows after it would move off
    // its real bottom. So a measured row keeps its measured size.
    const row = rowSizes.current.get(key);
    if (row) return row.size;
    const current = estimates.current.get(key);
    if (current !== undefined) return current;
    const sizeClass = rowInput.current.sizeClass(index);
    const measured = sizes.current.get(sizeClass);
    const estimate = measured?.count
      ? measured.total / measured.count
      : rowInput.current.defaultSize(sizeClass);
    estimates.current.set(key, estimate);
    return estimate;
  }, []);
  // Each row counts once, with its latest size, so rows that grow while
  // they stream do not outweigh the others.
  const recordSize = (key: Key, sizeClass: string, size: number) => {
    const previous = rowSizes.current.get(key);
    if (previous) {
      const total = sizes.current.get(previous.sizeClass)!;
      total.count -= 1;
      total.total -= previous.size;
    }
    rowSizes.current.set(key, { size, sizeClass });
    const total = sizes.current.get(sizeClass) ?? { count: 0, total: 0 };
    total.count += 1;
    total.total += size;
    sizes.current.set(sizeClass, total);
  };
  // A new estimate for a row moves the rows after it. The scroll owner
  // corrects that from the row that it recorded at the last scroll. So rows
  // take the latest estimates only on the render after a scroll, when that
  // row is current. A scroll by other code, such as a reveal, is then
  // recorded before rows move. Other renders keep each row's estimate.
  const instance = useRef<Virtualizer<Element, HTMLElement>>(null);
  const placement = useRef<{
    getItemKey: (index: number) => Key;
    scrollOffset?: number | null;
  }>(null);
  const scrollOffset = instance.current?.scrollOffset;
  if (!placement.current || placement.current.scrollOffset !== scrollOffset) {
    estimates.current.clear();
    placement.current = {
      getItemKey: (index) => rowInput.current.getItemKey(index),
      scrollOffset,
    };
  }
  const [scrollMargin, setScrollMargin] = useState(0);
  const keptKey = input.keptIndexes
    .filter((index) => index !== undefined && index >= 0 && index < input.count)
    .join(",");
  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = new Set(defaultRangeExtractor(range));
      if (keptKey) {
        for (const index of keptKey.split(",")) indexes.add(Number(index));
      }
      // Rows stay in document order, so the scroll owner can search them.
      return [...indexes].sort((left, right) => left - right);
    },
    [keptKey],
  );
  // Controls above the list, such as the earlier-page control, move it
  // down from the top of the scroll content. The margin only picks which
  // rows mount, so a reading from the last scroll or resize is close
  // enough: the overscan rows cover a small error.
  const measureScrollMargin = useCallback(() => {
    const list = listRef.current;
    const root = scrollRootFor(list);
    if (!list || !(root instanceof Element)) return;
    const margin =
      list.getBoundingClientRect().top -
      root.getBoundingClientRect().top +
      root.scrollTop;
    setScrollMargin((current) =>
      Math.abs(margin - current) >= 1 ? margin : current,
    );
  }, [listRef]);
  useLayoutEffect(measureScrollMargin, [measureScrollMargin]);
  // The dashboard build does not use React Compiler, so nothing memoizes
  // the values that this hook returns.
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer<Element, HTMLElement>({
    count: input.count,
    estimateSize,
    gap: input.gap,
    // A new function makes the virtualizer place every row again.
    getItemKey: placement.current.getItemKey,
    measureElement: (element, entry, instance) => {
      const size = measureElement(element, entry, instance);
      const index = instance.indexFromElement(element);
      recordSize(
        rowInput.current.getItemKey(index),
        rowInput.current.sizeClass(index),
        size,
      );
      return size;
    },
    // A server render has no scroll root, so mount the first rows that
    // fill about one screen.
    initialRect:
      typeof window === "undefined" ? { height: 1_000, width: 0 } : undefined,
    getScrollElement: () => {
      const root = scrollRootFor(listRef.current);
      return root instanceof Element ? root : null;
    },
    onChange: measureScrollMargin,
    overscan: OVERSCAN_ROWS,
    rangeExtractor,
    scrollMargin,
    // The scroll owner moves the scroll position. This only reads it.
    scrollToFn: () => {},
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;
  instance.current = virtualizer;
  return virtualizer;
}
