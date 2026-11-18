// The new UI fades one line of text at its right edge where it does not
// fit, in place of an ellipsis. A mask hides an element's own focus ring,
// so fade the text inside a link or button, not the link or button.

/**
 * One line of text that fades at its right edge. Use it on an element that
 * fills its column, so the fade reaches only text that does not fit.
 */
export const fadeTextClass =
  "min-w-0 overflow-hidden whitespace-nowrap [mask-image:linear-gradient(to_left,transparent,black_2rem)]";

/**
 * One line of text that fades at its right edge only while
 * `fadeWhenOverflowing` marks it. Use it on an element that is only as
 * wide as its text, which a fade would otherwise cut when it fits.
 */
export const fadeOverflowClass =
  "min-w-0 overflow-hidden whitespace-nowrap data-[overflow]:[mask-image:linear-gradient(to_left,transparent,black_2rem)]";

/**
 * Ref callback that sets `data-overflow` on an element while its text is
 * wider than the element.
 */
export function fadeWhenOverflowing(element: HTMLElement | null) {
  if (!element) return;
  const measure = () =>
    element.toggleAttribute(
      "data-overflow",
      element.scrollWidth > element.clientWidth,
    );
  measure();
  // A stretched element keeps its size when its text changes, so watch both.
  const resize = new ResizeObserver(measure);
  resize.observe(element);
  const text = new MutationObserver(measure);
  text.observe(element, {
    characterData: true,
    childList: true,
    subtree: true,
  });
  return () => {
    resize.disconnect();
    text.disconnect();
  };
}
