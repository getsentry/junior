// Adapted from shadcn/ui's Base UI Sheet. Drawer adds native swipe support.
// https://ui.shadcn.com/docs/components/base/sheet
import { Drawer as SheetPrimitive } from "@base-ui/react/drawer";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";

import {
  acquireBodyScrollLock,
  releaseBodyScrollLock,
} from "../bodyScrollLock";
import { cn } from "../styles";

const SheetContext = createContext<{
  closingRef: RefObject<boolean>;
  popupRef: RefObject<HTMLDivElement | null>;
  topmost: boolean;
} | null>(null);

// Separate roots can overlap when a resize mounts a sheet below an open drawer.
// Only the last modal in document order may trap focus or handle dismissal.
function subscribeToSheets(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.body, { childList: true, subtree: true });
  return () => observer.disconnect();
}

/** Keep modal state until Base UI finishes its close transition. */
export function Sheet(props: {
  children: ReactNode;
  onClose(): void;
  side: "right" | "bottom";
}) {
  const [open, setOpen] = useState(false);
  const closingRef = useRef(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const topmost = useSyncExternalStore(
    subscribeToSheets,
    () => {
      const modals = document.querySelectorAll("[data-dashboard-modal]");
      const last = modals[modals.length - 1];
      return popupRef.current ? last === popupRef.current : !last;
    },
    () => true,
  );
  useEffect(() => {
    // The mobile conversation shell uses this same document scroll lock.
    acquireBodyScrollLock();
    setOpen(true);
    return releaseBodyScrollLock;
  }, []);

  return (
    <SheetContext value={{ closingRef, popupRef, topmost }}>
      <SheetPrimitive.Root
        open={open}
        modal={topmost ? "trap-focus" : false}
        disablePointerDismissal={!topmost}
        swipeDirection={props.side === "bottom" ? "down" : "right"}
        onOpenChange={(open, details) => {
          if (!open && !topmost) {
            details.cancel();
            return;
          }
          closingRef.current = !open;
          setOpen(open);
        }}
        onOpenChangeComplete={(open) => {
          if (!open && closingRef.current) props.onClose();
        }}
      >
        {props.children}
      </SheetPrimitive.Root>
    </SheetContext>
  );
}

/** Close the enclosing sheet through its transition and focus lifecycle. */
export const SheetClose = SheetPrimitive.Close;

/** Render sheet chrome, a fading backdrop, and Base UI's focus boundary. */
export function SheetContent(
  props: {
    children: ReactNode;
    className?: string;
    initialFocusRef?: RefObject<HTMLElement | null>;
    side: "right" | "bottom";
  } & ({ label: string; titleId?: never } | { label?: never; titleId: string }),
) {
  const sheet = useContext(SheetContext);
  const popupRef = sheet?.popupRef;
  const portalRef = useRef<HTMLDivElement>(null);
  return (
    <>
      <div ref={portalRef} className="contents" />
      <SheetPrimitive.Portal container={portalRef}>
        <SheetPrimitive.Backdrop className="fixed inset-0 z-50 bg-dashboard-overlay opacity-[calc(1-var(--drawer-swipe-progress,0))] transition-opacity duration-180 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 data-[swiping]:transition-none motion-reduce:transition-none" />
        <SheetPrimitive.Viewport className="pointer-events-none fixed inset-0 z-50">
          <SheetPrimitive.Popup
            ref={popupRef}
            aria-modal={sheet?.topmost ? true : undefined}
            aria-label={props.label}
            aria-labelledby={props.titleId}
            data-dashboard-modal=""
            data-base-ui-swipe-ignore={props.side === "right" ? "" : undefined}
            finalFocus={() =>
              Boolean(sheet?.closingRef.current && sheet.topmost)
            }
            initialFocus={() => {
              // A resize can mount a sheet beneath an existing event dialog.
              const modals = document.querySelectorAll(
                "[data-dashboard-modal]",
              );
              if (modals[modals.length - 1] !== popupRef?.current) return false;
              return props.initialFocusRef?.current ?? true;
            }}
            className={cn(
              "pointer-events-auto grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] bg-dashboard-bg-elevated outline-none transition-[opacity,transform] duration-180 ease-[cubic-bezier(0.2,0.8,0.2,1)] data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 data-[swiping]:transition-none motion-reduce:transition-none",
              props.side === "bottom"
                ? "absolute inset-x-0 bottom-0 mx-auto h-[85dvh] max-h-full w-full max-w-2xl [transform:translateY(var(--drawer-swipe-movement-y,0px))] rounded-t-2xl border border-b-0 border-dashboard-border-strong shadow-[0_-12px_40px_rgba(0,0,0,0.25)] data-[ending-style]:[transform:translateY(100%)] data-[starting-style]:[transform:translateY(2.5rem)]"
                : "absolute right-0 top-0 h-full w-full shadow-[-12px_0_40px_rgba(0,0,0,0.25)] data-[ending-style]:[transform:translateX(2.5rem)] data-[starting-style]:[transform:translateX(2.5rem)] md:border-l md:border-dashboard-border-strong",
              props.className,
            )}
          >
            {props.children}
          </SheetPrimitive.Popup>
        </SheetPrimitive.Viewport>
      </SheetPrimitive.Portal>
    </>
  );
}

/** Keep text selection and scrolling separate from the swipe handle. */
export const SheetBody = SheetPrimitive.Content;
