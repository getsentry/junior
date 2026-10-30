import { X } from "lucide-react";
import { useRef, type ReactNode } from "react";

import { cn } from "../styles";
import { Button } from "./ui/button";
import {
  Drawer as DrawerRoot,
  DrawerClose,
  DrawerContent as DrawerPopup,
} from "./ui/drawer";
import { useSheet } from "./ui/useSheet";

type DrawerProps = {
  actions?: ReactNode;
  children: ReactNode;
  closeLabel: string;
  /** Remove the body inset, so content such as the event log meets the edges. */
  flush?: boolean;
  header: ReactNode;
  onClose(): void;
  openKey: string;
  width?: "default" | "wide" | "narrow";
} & ({ titleId: string; label?: never } | { label: string; titleId?: never });

/**
 * Render a side drawer with shared modal focus and dismissal behavior.
 * A drawer opened from inside another drawer stacks in front of it.
 */
export function Drawer(props: DrawerProps) {
  return <DrawerContent key={props.openKey} {...props} />;
}

function DrawerContent(props: DrawerProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const sheet = useSheet(props.onClose, closeRef);
  return (
    <DrawerRoot {...sheet.rootProps} swipeDirection="right">
      <DrawerPopup
        {...sheet.contentProps}
        aria-label={props.label}
        aria-labelledby={props.titleId}
        data-dashboard-modal=""
        className={cn(
          "data-[swipe-axis=x]:[--drawer-content-width:100%] data-[swipe-axis=x]:sm:[--drawer-content-width:100%]",
          props.width === "wide"
            ? "data-[swipe-axis=x]:md:[--drawer-content-width:min(760px,94vw)]"
            : props.width === "narrow"
              ? "data-[swipe-axis=x]:md:[--drawer-content-width:min(440px,94vw)]"
              : "data-[swipe-axis=x]:md:[--drawer-content-width:min(560px,94vw)]",
        )}
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-dashboard-border bg-dashboard-bg-elevated px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] md:px-5">
          <div className="min-w-0 flex-1">{props.header}</div>
          <div className="flex shrink-0 items-start gap-1.5">
            {props.actions}
            <DrawerClose
              render={
                <Button
                  ref={closeRef}
                  aria-label={props.closeLabel}
                  size="icon"
                />
              }
            >
              <X aria-hidden="true" size={15} strokeWidth={2.25} />
            </DrawerClose>
          </div>
        </header>
        <div
          className={cn(
            "min-h-0 flex-1 overflow-auto",
            props.flush
              ? "pb-[env(safe-area-inset-bottom)]"
              : "px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-5",
          )}
        >
          {props.children}
        </div>
      </DrawerPopup>
    </DrawerRoot>
  );
}
