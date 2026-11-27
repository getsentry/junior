import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import { cn } from "@dashboard/lib/utils";
import { keyboardBandStyle, useKeyboardBand } from "@dashboard/mobileViewport";

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
      // While a touch keyboard is open, a tall sheet fills the band above
      // it, and a form sheet ends at the keyboard's top edge.
      style={keyboardBandStyle(band, phoneSize === "full")}
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
          "min-h-0 flex-1 [&_[data-slot=dialog-title]]:pr-10",
          // The caller's classes style the centered dialog, such as its
          // padding and overflow. A form sheet keeps its own padding and
          // scroll. A tall sheet, such as the command palette, lays out
          // its own body.
          phoneSize === "full"
            ? [className, !band && "pb-[env(safe-area-inset-bottom)]"]
            : [
                className,
                "overflow-y-auto overscroll-contain px-5 pt-3",
                band ? "pb-5" : "pb-[max(1.25rem,env(safe-area-inset-bottom))]",
              ],
        )}
      >
        {children}
      </div>
    </DrawerContent>
  );
}
