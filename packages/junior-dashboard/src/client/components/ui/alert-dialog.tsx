// Adapted from shadcn/ui Base UI Alert Dialog. See shadcn.LICENSE.
import type { ComponentProps } from "react";
import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import { cn } from "@dashboard/lib/utils";
import { Button } from "./button";

/** Require an explicit response before a destructive action. */
export function AlertDialog(props: AlertDialogPrimitive.Root.Props) {
  return <AlertDialogPrimitive.Root {...props} />;
}

/** Show a named confirmation above the page with modal focus handling. */
export function AlertDialogContent({
  className,
  ...props
}: AlertDialogPrimitive.Popup.Props) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-dashboard-overlay transition-opacity duration-180 motion-reduce:transition-none data-ending-style:opacity-0 data-starting-style:opacity-0" />
      <AlertDialogPrimitive.Popup
        data-dashboard-modal=""
        data-slot="alert-dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid grid-cols-1 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-xl border border-dashboard-border-emphasis bg-dashboard-surface-raised p-5 text-dashboard-text shadow-lg outline-none transition-[opacity,scale] duration-180 motion-reduce:transition-none data-ending-style:opacity-0 data-starting-style:opacity-0 data-ending-style:scale-95 data-starting-style:scale-95",
          className,
        )}
        {...props}
      />
    </AlertDialogPrimitive.Portal>
  );
}

/** Name the action that needs confirmation. */
export function AlertDialogTitle({
  className,
  ...props
}: AlertDialogPrimitive.Title.Props) {
  return (
    <AlertDialogPrimitive.Title
      className={cn("m-0 font-display text-lg font-medium", className)}
      {...props}
    />
  );
}

/** Describe what the action changes before the user confirms it. */
export function AlertDialogDescription({
  className,
  ...props
}: AlertDialogPrimitive.Description.Props) {
  return (
    <AlertDialogPrimitive.Description
      className={cn(
        "m-0 break-words text-sm leading-relaxed text-dashboard-text-muted",
        className,
      )}
      {...props}
    />
  );
}

/** Keep confirmation controls together and reachable on small screens. */
export function AlertDialogFooter({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-wrap justify-end gap-2", className)}
      {...props}
    />
  );
}

/** Run the confirmed action; its owner decides when the dialog can close. */
export function AlertDialogAction(props: ComponentProps<typeof Button>) {
  return (
    <Button data-slot="alert-dialog-action" className="min-h-11" {...props} />
  );
}

/** Cancel through Base UI so focus returns to the source control. */
export function AlertDialogCancel(props: AlertDialogPrimitive.Close.Props) {
  return (
    <AlertDialogPrimitive.Close
      render={<Button className="min-h-11" />}
      {...props}
    />
  );
}
