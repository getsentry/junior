import type { ReactNode } from "react";

import { Sheet, SheetBody, SheetContent } from "./Sheet";

/** Show details in a Base UI sheet with a swipe handle and no header controls. */
export function BottomSheet(props: {
  children: ReactNode;
  label: string;
  onClose(): void;
}) {
  return (
    <Sheet onClose={props.onClose} side="bottom">
      <SheetContent label={props.label} side="bottom">
        <div className="rounded-t-2xl px-4 pt-1 md:px-5">
          <div
            aria-hidden="true"
            data-drawer-handle=""
            className="flex touch-none cursor-grab justify-center py-3 active:cursor-grabbing"
          >
            <span className="h-1 w-9 rounded-full bg-dashboard-border-interactive" />
          </div>
        </div>
        <SheetBody
          data-base-ui-swipe-ignore=""
          className="min-h-0 overflow-y-auto overscroll-contain"
        >
          {props.children}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
