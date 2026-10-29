import { useRef, type ReactNode } from "react";

import { cn } from "../styles";
import { Sheet, SheetContent, SheetHeader } from "./ui/sheet";
import { useSheet } from "./ui/useSheet";

type DrawerProps = {
  actions?: ReactNode;
  children: ReactNode;
  closeLabel: string;
  header: ReactNode;
  onClose(): void;
  openKey: string;
  width?: "default" | "wide" | "narrow";
} & ({ titleId: string; label?: never } | { label: string; titleId?: never });

/** Render a side drawer with shared modal focus and dismissal behavior. */
export function Drawer(props: DrawerProps) {
  return <DrawerContent key={props.openKey} {...props} />;
}

function DrawerContent(props: DrawerProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const sheet = useSheet(props.onClose, closeRef);
  return (
    <Sheet {...sheet.rootProps}>
      <SheetContent
        {...sheet.contentProps}
        aria-label={props.label}
        aria-labelledby={props.titleId}
        side="right"
        closeButtonProps={{
          ref: closeRef,
          "aria-label": props.closeLabel,
          className:
            "right-4 top-[max(0.75rem,env(safe-area-inset-top))] md:right-5",
        }}
        className={cn(
          "grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] gap-0 outline-none data-[side=right]:w-full data-[side=right]:sm:max-w-none",
          props.width === "wide"
            ? "data-[side=right]:md:w-[min(760px,94vw)]"
            : props.width === "narrow"
              ? "data-[side=right]:md:w-[min(440px,94vw)]"
              : "data-[side=right]:md:w-[min(560px,94vw)]",
        )}
      >
        <SheetHeader className="flex-row items-start gap-3 border-b border-dashboard-border bg-dashboard-bg-elevated px-4 py-3 pr-14 pt-[max(0.75rem,env(safe-area-inset-top))] md:pl-5 md:pr-14">
          <div className="min-w-0 flex-1">{props.header}</div>
          {props.actions ? (
            <div className="flex items-start gap-1.5">{props.actions}</div>
          ) : null}
        </SheetHeader>
        <div className="min-h-0 overflow-auto px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-5">
          {props.children}
        </div>
      </SheetContent>
    </Sheet>
  );
}
