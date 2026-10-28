import type { ReactNode } from "react";

import { Sheet, SheetContent, SheetHeader, SheetTitle } from "./ui/sheet";
import { useSheet } from "./ui/useSheet";

/** Show app details in the shadcn sheet with a visible title and close control. */
export function BottomSheet(props: {
  children: ReactNode;
  label: string;
  onClose(): void;
}) {
  const sheet = useSheet(props.onClose);
  return (
    <Sheet {...sheet.rootProps}>
      <SheetContent
        {...sheet.contentProps}
        aria-label={props.label}
        side="bottom"
        className="mx-auto max-h-full w-full max-w-2xl gap-0 rounded-t-2xl outline-none data-[side=bottom]:h-[85dvh]"
      >
        <SheetHeader className="border-b border-dashboard-border">
          <SheetTitle>{props.label}</SheetTitle>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {props.children}
        </div>
      </SheetContent>
    </Sheet>
  );
}
