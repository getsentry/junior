import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import { cn } from "../styles";
import { Button } from "./Button";

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Render an accessible modal drawer and own its focus and scroll lifecycle. */
export function Drawer(props: {
  actions?: ReactNode;
  children: ReactNode;
  closeLabel: string;
  dismissLabel: string;
  header: ReactNode;
  onClose(): void;
  openKey: string;
  titleId: string;
  width?: "default" | "wide";
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(props.onClose);
  const previousFocusRef = useRef<HTMLElement | undefined>(undefined);
  onCloseRef.current = props.onClose;

  useEffect(() => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = requestAnimationFrame(() => {
      dialogRef.current
        ?.querySelector<HTMLElement>("[data-drawer-close]")
        ?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
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
      document.body.style.overflow = previousOverflow;
      const previousFocus = previousFocusRef.current;
      previousFocusRef.current = undefined;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [props.openKey]);

  return (
    <div
      aria-labelledby={props.titleId}
      aria-modal="true"
      className="fixed inset-0 z-50"
      ref={dialogRef}
      role="dialog"
    >
      <button
        aria-label={props.dismissLabel}
        className="absolute inset-0 cursor-default bg-black/55"
        onClick={props.onClose}
        tabIndex={-1}
        type="button"
      />
      <aside
        className={cn(
          "absolute top-0 right-0 grid h-full w-full grid-rows-[auto_minmax(0,1fr)] bg-[#070707] shadow-[-20px_0_60px_rgba(0,0,0,0.45)] md:border-l md:border-white/12",
          props.width === "wide"
            ? "md:w-[min(760px,94vw)]"
            : "md:w-[min(560px,94vw)]",
        )}
      >
        <header className="relative grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-white/10 bg-dashboard-surface-raised px-4 py-3 md:px-5">
          <div className="min-w-0">{props.header}</div>
          <div className="flex items-start gap-1.5">
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
        <div className="min-h-0 overflow-auto px-4 py-4 md:px-5">
          {props.children}
        </div>
      </aside>
    </div>
  );
}
