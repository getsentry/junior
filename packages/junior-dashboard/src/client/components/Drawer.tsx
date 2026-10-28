import { X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  acquireBodyScrollLock,
  releaseBodyScrollLock,
} from "../bodyScrollLock";
import { cn } from "../styles";
import { Button } from "./Button";

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Render a modal drawer or bottom sheet and own its focus and scroll lifecycle. */
export function Drawer(props: {
  actions?: ReactNode;
  children: ReactNode;
  closeLabel: string;
  dismissLabel: string;
  header: ReactNode;
  onClose(): void;
  openKey: string;
  /** Bottom sheets keep the same modal behavior as side drawers. */
  placement?: "side" | "bottom";
  titleId: string;
  width?: "default" | "wide" | "narrow";
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(props.onClose);
  const previousFocusRef = useRef<HTMLElement | undefined>(undefined);
  const dragStartRef = useRef<number | undefined>(undefined);
  const [sheetOffset, setSheetOffset] = useState(0);
  const bottom = props.placement === "bottom";
  onCloseRef.current = props.onClose;

  useEffect(() => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    acquireBodyScrollLock();
    const focusFrame = requestAnimationFrame(() => {
      // A responsive sheet can mount below an already open event dialog.
      const drawers = document.querySelectorAll("[data-dashboard-drawer]");
      if (drawers[drawers.length - 1] !== dialogRef.current) return;
      dialogRef.current
        ?.querySelector<HTMLElement>("[data-drawer-close]")
        ?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      // An event detail drawer can open above a child conversation drawer.
      // Only the last mounted drawer owns Escape and the focus trap.
      const drawers = document.querySelectorAll("[data-dashboard-drawer]");
      if (drawers[drawers.length - 1] !== dialogRef.current) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const dialog = dialogRef.current;
      const focusable = Array.from(
        dialog?.querySelectorAll<HTMLElement>(focusableSelector) ?? [],
      ).filter(
        (element) =>
          element.tabIndex >= 0 && element.getClientRects().length > 0,
      );
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
      const previousFocus = previousFocusRef.current;
      previousFocusRef.current = undefined;
      const drawers = document.querySelectorAll("[data-dashboard-drawer]");
      const topDrawer = drawers[drawers.length - 1];
      if (
        previousFocus?.isConnected &&
        (!topDrawer || topDrawer.contains(previousFocus))
      ) {
        previousFocus.focus();
      }
    };
  }, [props.openKey]);

  return (
    <div
      aria-labelledby={props.titleId}
      aria-modal="true"
      data-dashboard-drawer=""
      className="fixed inset-0 z-50"
      ref={dialogRef}
      role="dialog"
    >
      <button
        aria-label={props.dismissLabel}
        className="absolute inset-0 cursor-default bg-dashboard-overlay"
        onClick={props.onClose}
        tabIndex={-1}
        type="button"
      />
      <aside
        className={cn(
          "absolute grid w-full grid-rows-[auto_minmax(0,1fr)] bg-dashboard-bg-elevated shadow-[-20px_0_60px_rgba(0,0,0,0.45)]",
          bottom
            ? "inset-x-0 bottom-0 mx-auto h-[85dvh] max-h-full max-w-2xl rounded-t-2xl border border-b-0 border-dashboard-border-strong"
            : cn(
                "right-0 top-0 h-full md:border-l md:border-dashboard-border-strong",
                props.width === "wide"
                  ? "md:w-[min(760px,94vw)]"
                  : props.width === "narrow"
                    ? "md:w-[min(440px,94vw)]"
                    : "md:w-[min(560px,94vw)]",
              ),
        )}
        style={
          bottom && sheetOffset
            ? { transform: `translateY(${sheetOffset}px)` }
            : undefined
        }
      >
        <header
          className={cn(
            "relative grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-b border-dashboard-border bg-dashboard-bg-elevated px-4 pb-3 md:px-5",
            bottom
              ? "rounded-t-2xl pt-1"
              : "pt-[max(0.75rem,env(safe-area-inset-top))]",
          )}
        >
          {bottom ? (
            <div
              aria-hidden="true"
              data-drawer-handle=""
              className="col-span-2 flex touch-none cursor-grab justify-center py-3 active:cursor-grabbing"
              onPointerDown={(event) => {
                dragStartRef.current = event.clientY;
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (dragStartRef.current !== undefined) {
                  setSheetOffset(
                    Math.max(0, event.clientY - dragStartRef.current),
                  );
                }
              }}
              onPointerUp={(event) => {
                const distance =
                  event.clientY - (dragStartRef.current ?? event.clientY);
                dragStartRef.current = undefined;
                setSheetOffset(0);
                if (distance >= 80) props.onClose();
              }}
              onPointerCancel={() => {
                dragStartRef.current = undefined;
                setSheetOffset(0);
              }}
            >
              <span className="h-1 w-9 rounded-full bg-dashboard-border-interactive" />
            </div>
          ) : null}
          <div className="min-w-0">{props.header}</div>
          <div
            className={cn(
              "flex items-start gap-1.5",
              bottom && "absolute right-3 top-1 md:right-4",
            )}
          >
            {props.actions}
            <Button
              aria-label={props.closeLabel}
              data-drawer-close
              onClick={props.onClose}
              size="icon"
              title="Close"
            >
              <X aria-hidden="true" size={15} strokeWidth={2.25} />
            </Button>
          </div>
        </header>
        <div className="min-h-0 overflow-auto px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-5">
          {props.children}
        </div>
      </aside>
    </div>
  );
}
