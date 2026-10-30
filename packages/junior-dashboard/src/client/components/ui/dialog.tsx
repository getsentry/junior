import type { ComponentProps } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { cn } from "@dashboard/lib/utils";

/** Own the open state and modal focus rules for a centered dialog. */
function Dialog(props: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

/** Close the dialog through Base UI dismissal and focus handling. */
function DialogClose(props: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

/** Show a short task above the page. Small screens keep it near the top, clear of the keyboard. */
function DialogContent({ className, ...props }: DialogPrimitive.Popup.Props) {
  return (
    <DialogPrimitive.Portal data-slot="dialog-portal">
      {/* Dim an open sheet too, so a dialog opened from it stands out. */}
      <DialogPrimitive.Backdrop
        forceRender
        data-slot="dialog-overlay"
        className="fixed inset-0 z-50 bg-dashboard-overlay transition-opacity duration-180 motion-reduce:transition-none data-ending-style:opacity-0 data-starting-style:opacity-0"
      />
      <DialogPrimitive.Popup
        data-dashboard-modal=""
        data-slot="dialog-content"
        className={cn(
          "fixed top-[max(1rem,env(safe-area-inset-top))] left-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 gap-4 overflow-y-auto rounded-xl border border-dashboard-border-emphasis bg-dashboard-surface-raised p-5 text-sm text-dashboard-text shadow-lg outline-none transition-[opacity,scale] duration-180 motion-reduce:transition-none data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 sm:top-1/2 sm:-translate-y-1/2",
          className,
        )}
        {...props}
      />
    </DialogPrimitive.Portal>
  );
}

/** Name the dialog task. */
function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("m-0 font-display text-lg font-medium", className)}
      {...props}
    />
  );
}

/** Keep dialog actions together at the end of the dialog. */
function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("flex flex-wrap justify-end gap-2", className)}
      {...props}
    />
  );
}

export { Dialog, DialogClose, DialogContent, DialogFooter, DialogTitle };
