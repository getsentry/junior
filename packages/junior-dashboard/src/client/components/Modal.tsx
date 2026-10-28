import { useEffect, useRef, type ReactNode, type RefObject } from "react";

import {
  acquireBodyScrollLock,
  releaseBodyScrollLock,
} from "../bodyScrollLock";

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Find visible controls that belong to the modal's keyboard focus cycle. */
function focusableElements(dialog: HTMLElement | null): HTMLElement[] {
  return Array.from(
    dialog?.querySelectorAll<HTMLElement>(focusableSelector) ?? [],
  ).filter(
    (element) => element.tabIndex >= 0 && element.getClientRects().length > 0,
  );
}

/** Own modal labeling, backdrop dismissal, keyboard focus, and document scroll. */
export function Modal(
  props: {
    children: ReactNode;
    dismissLabel: string;
    initialFocusRef?: RefObject<HTMLElement | null>;
    onClose(): void;
  } & ({ label: string; titleId?: never } | { label?: never; titleId: string }),
) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(props.onClose);
  const initialFocusRef = props.initialFocusRef;
  onCloseRef.current = props.onClose;

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    acquireBodyScrollLock();
    const focusFrame = requestAnimationFrame(() => {
      // Resizing can mount a sheet below an already open event dialog.
      const modals = document.querySelectorAll("[data-dashboard-modal]");
      if (modals[modals.length - 1] !== dialogRef.current) return;
      const dialog = dialogRef.current;
      const initialFocus =
        initialFocusRef?.current ?? focusableElements(dialog).at(0) ?? dialog;
      initialFocus?.focus({ preventScroll: true });
    });
    const onKeyDown = (event: KeyboardEvent) => {
      const modals = document.querySelectorAll("[data-dashboard-modal]");
      if (modals[modals.length - 1] !== dialogRef.current) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      const focusable = focusableElements(dialog);
      const first = focusable.at(0);
      const last = focusable.at(-1);
      if (!dialog || !first || !last) {
        event.preventDefault();
        return;
      }
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (active === last || !dialog.contains(active))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", onKeyDown);
      releaseBodyScrollLock();
      const modals = document.querySelectorAll("[data-dashboard-modal]");
      const topModal = modals[modals.length - 1];
      if (
        previousFocus?.isConnected &&
        (!topModal || topModal.contains(previousFocus))
      ) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, [initialFocusRef]);

  return (
    <div
      aria-label={props.label}
      aria-labelledby={props.titleId}
      aria-modal="true"
      data-dashboard-modal=""
      className="fixed inset-0 z-50"
      ref={dialogRef}
      role="dialog"
      tabIndex={-1}
    >
      <button
        aria-label={props.dismissLabel}
        className="absolute inset-0 cursor-default bg-dashboard-overlay"
        onClick={props.onClose}
        tabIndex={-1}
        type="button"
      />
      {props.children}
    </div>
  );
}
