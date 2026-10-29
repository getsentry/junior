// Adapted from shadcn/ui Base UI Popover. See shadcn.LICENSE.
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { cn } from "@dashboard/lib/utils";

/** Own an anchored popover's state and dismissal. */
export function Popover(props: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root {...props} />;
}

/** Open a popover from the owning control. */
export function PopoverTrigger(props: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

/** Position popover content within the viewport and share its themed surface. */
export function PopoverContent({
  className,
  align = "center",
  side = "bottom",
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<PopoverPrimitive.Positioner.Props, "align" | "side">) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        align={align}
        side={side}
        sideOffset={8}
        className="isolate z-50"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            "w-80 max-w-[calc(100vw-2rem)] max-h-(--available-height) origin-(--transform-origin) overflow-y-auto rounded-lg border border-dashboard-border-emphasis bg-dashboard-surface-raised p-4 text-sm text-dashboard-text shadow-lg outline-none focus-visible:outline-2 focus-visible:outline-dashboard-focus transition-[opacity,scale] duration-180 motion-reduce:transition-none data-ending-style:opacity-0 data-starting-style:opacity-0 data-ending-style:scale-95 data-starting-style:scale-95",
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

/** Name a popover through its visible heading. */
export function PopoverTitle({
  className,
  ...props
}: PopoverPrimitive.Title.Props) {
  return (
    <PopoverPrimitive.Title
      className={cn("m-0 text-sm font-medium", className)}
      {...props}
    />
  );
}

/** Explain a popover without duplicating its heading. */
export function PopoverDescription({
  className,
  ...props
}: PopoverPrimitive.Description.Props) {
  return (
    <PopoverPrimitive.Description
      className={cn("m-0 leading-relaxed text-dashboard-text-muted", className)}
      {...props}
    />
  );
}
