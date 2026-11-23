import type { MouseEvent as ReactMouseEvent } from "react";
import { useHref, useNavigate } from "react-router";

/**
 * Whether a click on a row head belongs to something else: a control in
 * the head, or a popover that React bubbles through the head from a portal.
 */
function onControl(event: { currentTarget: Element; target: EventTarget }) {
  const { target } = event;
  return (
    !(target instanceof Element) ||
    !event.currentTarget.contains(target) ||
    Boolean(target.closest("a, button"))
  );
}

/**
 * Opens `path` as a click on a link to it does: a Ctrl/⌘ or Shift click, or
 * a middle click, opens a new tab.
 */
export function useOpenPath(path: string) {
  const navigate = useNavigate();
  const href = useHref(path);
  return (event: MouseEvent) => {
    if (event.button === 1 || event.metaKey || event.ctrlKey || event.shiftKey)
      window.open(href, "_blank", "noopener");
    else void navigate(path);
  };
}

/**
 * Click handlers for a row head or a stack header: a click does what its
 * link does, except on the links and buttons in it, or at the end of a text
 * selection. With `toggle`, a plain click toggles instead, and a middle
 * click does nothing.
 */
export function openOnClick(
  open: (event: MouseEvent) => void,
  toggle?: () => void,
) {
  return {
    onAuxClick: (event: ReactMouseEvent<HTMLElement>) => {
      if (event.button !== 1 || toggle || onControl(event)) return;
      open(event.nativeEvent);
    },
    // A middle press would start the browser's autoscroll, not the new tab
    // that its click opens.
    onMouseDown: (event: ReactMouseEvent<HTMLElement>) => {
      if (event.button === 1 && !toggle && !onControl(event))
        event.preventDefault();
    },
    onClick: (event: ReactMouseEvent<HTMLElement>) => {
      if (event.button !== 0 || onControl(event)) return;
      if (toggle) return toggle();
      if (window.getSelection()?.isCollapsed === false) return;
      open(event.nativeEvent);
    },
  };
}

/**
 * Handlers that run `opened` when a link opens: a click of any kind, or a
 * middle click, which fires `auxclick` and not `click`.
 */
export function onLinkOpen(opened: (() => void) | undefined) {
  return {
    onAuxClick: (event: ReactMouseEvent<HTMLElement>) => {
      if (event.button === 1) opened?.();
    },
    onClick: opened,
  };
}
