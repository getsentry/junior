import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { cn } from "@dashboard/lib/utils";

/** Own the open state and modal focus rules for a dialog. */
function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

/** Close the dialog through Base UI dismissal and focus handling. */
function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-dashboard-overlay transition-opacity duration-180 motion-reduce:transition-none data-ending-style:opacity-0 data-starting-style:opacity-0",
        className,
      )}
      {...props}
    />
  );
}

/** Show the dialog above a backdrop, centered in the viewport. */
function DialogContent({ className, ...props }: DialogPrimitive.Popup.Props) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        data-dashboard-modal=""
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl border border-dashboard-border-emphasis bg-dashboard-surface-raised p-4 text-sm text-dashboard-text shadow-lg outline-none transition-[opacity,scale] duration-180 motion-reduce:transition-none sm:max-w-sm data-ending-style:opacity-0 data-starting-style:opacity-0 data-ending-style:scale-95 data-starting-style:scale-95",
          className,
        )}
        {...props}
      />
    </DialogPortal>
  );
}

/** Give the dialog its accessible name. */
function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "m-0 text-base leading-none font-medium text-dashboard-text",
        className,
      )}
      {...props}
    />
  );
}

export { Dialog, DialogClose, DialogContent, DialogTitle };
