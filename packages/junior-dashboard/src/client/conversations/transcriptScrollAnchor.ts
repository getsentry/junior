/**
 * Keep the reader's place while transcript layout changes.
 *
 * Rows mark themselves with `data-scroll-anchor`. The anchor is the first row
 * that starts inside the viewport. When no row starts there, it is the row that
 * covers the viewport top. After a layout change, the scroll owner moves the
 * scroll position by the distance that the anchor moved. This covers earlier
 * pages, late images, and deferred rendering above the reader.
 *
 * Transcript content turns off browser scroll anchoring. Safari does not
 * support it, so one rule keeps every browser the same.
 */

const SCROLL_ANCHOR_ATTRIBUTE = "data-scroll-anchor";

/** A row and its offset from the viewport top when the reader last moved. */
export type ScrollAnchor = {
  element: HTMLElement;
  key: string;
  offset: number;
};

type VerticalBounds = { bottom: number; top: number };

/**
 * Find the anchor row in rows that are in document order.
 *
 * Rows do not overlap, so a binary search finds the first row below the
 * viewport top with a few layout reads.
 */
export function scrollAnchorIndex(
  count: number,
  rowAt: (index: number) => VerticalBounds,
  viewport: VerticalBounds,
): number | null {
  let low = 0;
  let high = count;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (rowAt(middle).bottom <= viewport.top) low = middle + 1;
    else high = middle;
  }
  if (low >= count) return null;
  if (rowAt(low).top >= viewport.top) return low;
  if (low + 1 < count && rowAt(low + 1).top < viewport.bottom) return low + 1;
  return low;
}

/** Record which row holds the reader's place inside `viewport`. */
export function captureScrollAnchor(
  content: HTMLElement,
  viewport: VerticalBounds,
): ScrollAnchor | null {
  const rows = content.querySelectorAll<HTMLElement>(
    `[${SCROLL_ANCHOR_ATTRIBUTE}]`,
  );
  const bounds = new Map<number, DOMRect>();
  const rowAt = (index: number) => {
    let rect = bounds.get(index);
    if (!rect) {
      rect = rows[index]!.getBoundingClientRect();
      bounds.set(index, rect);
    }
    return rect;
  };
  const index = scrollAnchorIndex(rows.length, rowAt, viewport);
  if (index === null) return null;
  const element = rows[index]!;
  return {
    element,
    key: element.getAttribute(SCROLL_ANCHOR_ATTRIBUTE) ?? "",
    offset: rowAt(index).top - viewport.top,
  };
}

/**
 * Measure how far the anchor moved since it was recorded.
 *
 * Returns `null` when the anchor row is gone, for example after a search
 * filter or view change. The caller then records a new anchor.
 */
export function scrollAnchorShift(
  content: HTMLElement,
  viewport: VerticalBounds,
  anchor: ScrollAnchor,
): number | null {
  const element = anchor.element.isConnected
    ? anchor.element
    : findAnchorRow(content, anchor.key);
  if (!element) return null;
  return element.getBoundingClientRect().top - viewport.top - anchor.offset;
}

function findAnchorRow(content: HTMLElement, key: string): HTMLElement | null {
  for (const row of content.querySelectorAll<HTMLElement>(
    `[${SCROLL_ANCHOR_ATTRIBUTE}]`,
  )) {
    if (row.getAttribute(SCROLL_ANCHOR_ATTRIBUTE) === key) return row;
  }
  return null;
}
