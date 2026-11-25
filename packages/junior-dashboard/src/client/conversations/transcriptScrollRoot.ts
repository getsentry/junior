import type { ScrollSnapshot } from "./transcriptBottomPinning";

/** The element, or the window, that scrolls the transcript. */
export type ScrollRoot = HTMLElement | Window;

/** Find the nearest element that scrolls the transcript, or the window. */
export function scrollRootFor(element: HTMLElement | null): ScrollRoot | null {
  if (typeof window === "undefined") return null;
  if (!element) return window;

  let current = element.parentElement;
  while (current && current !== document.body) {
    const style = window.getComputedStyle(current);
    if (/(auto|scroll|overlay)/.test(style.overflowY)) return current;
    current = current.parentElement;
  }

  return window;
}

/** Read the scroll position and size of a scroll root. */
export function scrollSnapshot(root: ScrollRoot): ScrollSnapshot {
  if (isWindowRoot(root)) {
    const element = document.scrollingElement ?? document.documentElement;
    return {
      clientHeight: window.innerHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: window.scrollY || element.scrollTop,
    };
  }

  return {
    clientHeight: root.clientHeight,
    scrollHeight: root.scrollHeight,
    scrollTop: root.scrollTop,
  };
}

/** Scroll a scroll root to `scrollTop`. */
export function setScrollTop(
  root: ScrollRoot,
  scrollTop: number,
  behavior: ScrollBehavior = "auto",
): void {
  if (isWindowRoot(root)) {
    window.scrollTo({ behavior, top: scrollTop });
    return;
  }
  root.scrollTo({ behavior, top: scrollTop });
}

/** Read the visible band of a scroll root in client coordinates. */
export function viewportBounds(root: ScrollRoot): {
  bottom: number;
  top: number;
} {
  if (isWindowRoot(root)) return { bottom: window.innerHeight, top: 0 };
  const top = root.getBoundingClientRect().top;
  return { bottom: top + root.clientHeight, top };
}

/** True when the window scrolls the transcript. */
export function isWindowRoot(root: ScrollRoot): root is Window {
  return root === window;
}

/** Scroll smoothly for an explicit move, unless the reader asks for reduced motion. */
export function preferredExplicitScrollBehavior(): ScrollBehavior {
  if (typeof window === "undefined") return "auto";
  if (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    return "auto";
  }
  return "smooth";
}
