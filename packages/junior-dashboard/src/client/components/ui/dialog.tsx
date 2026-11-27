import {
  createContext,
  lazy,
  Suspense,
  useContext,
  type ComponentProps,
} from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { cn } from "@dashboard/lib/utils";
import { useMobileLayoutWhileOpen } from "@dashboard/layoutMedia";

const loadDialogSheet = () => import("./dialogSheet");
const DialogSheetRoot = lazy(() =>
  loadDialogSheet().then((module) => ({ default: module.DialogSheetRoot })),
);
const DialogSheetContent = lazy(() =>
  loadDialogSheet().then((module) => ({ default: module.DialogSheetContent })),
);

// True when `DialogContent` renders as a phone sheet.
const DialogSheet = createContext(false);

/** Props of a dialog root. */
export type DialogProps = Omit<
  DialogPrimitive.Root.Props,
  "handle" | "onOpenChange"
> & {
  /** The dialog and the drawer give different details. Read only `cancel`. */
  onOpenChange?(open: boolean, details: { cancel(): void }): void;
  /** Keep a full-screen dialog, such as the image viewer, out of the sheet. */
  phoneFullScreen?: boolean;
};

/**
 * Own the open state and modal focus rules for a centered dialog. A phone
 * shows it as a bottom sheet, which a swipe down also closes.
 */
function Dialog({ phoneFullScreen, ...props }: DialogProps) {
  const sheet =
    useMobileLayoutWhileOpen(Boolean(props.open)) && !phoneFullScreen;
  return (
    <DialogSheet.Provider value={sheet}>
      {sheet ? (
        <Suspense fallback={null}>
          <DialogSheetRoot {...props} />
        </Suspense>
      ) : (
        <DialogPrimitive.Root data-slot="dialog" {...props} />
      )}
    </DialogSheet.Provider>
  );
}

/** Close the dialog through Base UI dismissal and focus handling. */
function DialogClose(props: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

/** The body classes that the centered dialog and the phone sheet share. */
export const DIALOG_BODY_CLASS = "grid gap-4 text-sm text-foreground";

/** Props of a dialog's content. */
export type DialogContentProps = Omit<
  DialogPrimitive.Popup.Props,
  "className" | "render"
> & {
  className?: string;
  /** On a phone, `full` is a fixed tall sheet. It fits its content by default. */
  phoneSize?: "content" | "full";
};

/**
 * Show a short task above the page. A phone shows it as a bottom sheet that
 * fits its content, with a close button, above the keyboard while it is open.
 */
function DialogContent({
  children,
  className,
  phoneSize,
  ...props
}: DialogContentProps) {
  const sheet = useContext(DialogSheet);
  if (sheet) {
    return (
      <DialogSheetContent
        className={className}
        phoneSize={phoneSize}
        {...props}
      >
        {children}
      </DialogSheetContent>
    );
  }
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
          "fixed top-[max(1rem,env(safe-area-inset-top))] left-1/2 z-50 max-h-[calc(100dvh-max(1rem,env(safe-area-inset-top))-max(1rem,env(safe-area-inset-bottom)))] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 overflow-y-auto rounded-xl border border-input bg-secondary p-5 shadow-lg outline-none transition-[opacity,scale] duration-180 motion-reduce:transition-none data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 sm:top-1/2 sm:max-h-[calc(100dvh-2rem)] sm:-translate-y-1/2",
          DIALOG_BODY_CLASS,
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Popup>
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
