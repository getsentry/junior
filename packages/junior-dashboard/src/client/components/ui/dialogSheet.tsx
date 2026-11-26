import type { CSSProperties } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import { cn } from "@dashboard/lib/utils";
import { useKeyboardBand } from "@dashboard/mobileViewport";

import { Button } from "./button";
import {
  DIALOG_BODY_CLASS,
  type DialogContentProps,
  type DialogProps,
} from "./dialog";
import { Drawer, DrawerContent } from "./drawer";

// `Dialog` loads this module on demand, so the drawer code loads with the
// first dialog that opens on a phone, not with the page.

/** The phone form of `Dialog`: a swipe drawer root. */
export function DialogSheetRoot(props: Omit<DialogProps, "phoneFullScreen">) {
  // The drawer root shares the dialog's context, so the dialog's title,
  // close, and popup props work in it.
  return <Drawer data-slot="dialog" {...props} />;
}

/**
 * The phone form of `DialogContent`: a bottom sheet that fits its content,
 * with a close button, above the keyboard while it is open.
 */
export function DialogSheetContent({
  children,
  className,
  phoneSize,
  ...props
}: DialogContentProps) {
  const band = useKeyboardBand();
  // While a touch keyboard is open, the sheet ends at the keyboard's top
  // edge, so the field in focus stays in view.
  const style: CSSProperties | undefined = band
    ? {
        bottom: `calc(100% - ${band.offsetTopPx + band.heightPx}px)`,
        maxHeight: `${band.heightPx}px`,
      }
    : undefined;
  return (
    <DrawerContent
      {...props}
      className={cn(
        "mx-auto w-full max-w-2xl bg-dashboard-bg-elevated",
        phoneSize === "full" && !band && "h-[85dvh]",
      )}
      data-dashboard-modal=""
      data-slot="dialog-content"
      // As on a desktop, a dialog opened from a sheet dims it too.
      forceOverlay
      style={style}
    >
      <div
        aria-hidden="true"
        className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-dashboard-border-strong"
      />
      <DialogPrimitive.Close
        render={
          <Button
            aria-label="Close"
            className="absolute top-3 right-2 z-10 pointer-coarse:size-11"
            size="icon"
            variant="ghost"
          />
        }
      >
        <XIcon aria-hidden="true" size={16} strokeWidth={2.25} />
      </DialogPrimitive.Close>
      <div
        className={cn(
          DIALOG_BODY_CLASS,
          "min-h-0 overflow-y-auto overscroll-contain px-5 pt-3 [&>[data-slot=dialog-title]:first-child]:pr-10",
          !band && "pb-[max(1.25rem,env(safe-area-inset-bottom))]",
          band && "pb-5",
          className,
        )}
      >
        {children}
      </div>
    </DrawerContent>
  );
}
