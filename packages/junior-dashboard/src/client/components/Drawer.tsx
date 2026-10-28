import { X } from "lucide-react";
import { useRef, type ReactNode } from "react";

import { cn } from "../styles";
import { Button } from "./Button";
import { Sheet, SheetClose, SheetContent } from "./ui/sheet";
import { useSheet } from "./ui/useSheet";

type DrawerProps = {
  actions?: ReactNode;
  children: ReactNode;
  closeLabel: string;
  header: ReactNode;
  onClose(): void;
  openKey: string;
  titleId: string;
  width?: "default" | "wide" | "narrow";
};

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
        aria-labelledby={props.titleId}
        side="right"
        showCloseButton={false}
        className={cn(
          "grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] gap-0 outline-none data-[side=right]:w-full data-[side=right]:sm:max-w-none",
          props.width === "wide"
            ? "data-[side=right]:md:w-[min(760px,94vw)]"
            : props.width === "narrow"
              ? "data-[side=right]:md:w-[min(440px,94vw)]"
              : "data-[side=right]:md:w-[min(560px,94vw)]",
        )}
      >
        <header className="relative grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-dashboard-border bg-dashboard-bg-elevated px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] md:px-5">
          <div className="min-w-0">{props.header}</div>
          <div className="flex items-start gap-1.5">
            {props.actions}
            <SheetClose
              render={
                <Button
                  ref={closeRef}
                  aria-label={props.closeLabel}
                  size="icon"
                  title="Close"
                />
              }
            >
              <X aria-hidden="true" size={15} strokeWidth={2.25} />
            </SheetClose>
          </div>
        </header>
        <div className="min-h-0 overflow-auto px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-5">
          {props.children}
        </div>
      </SheetContent>
    </Sheet>
  );
}
