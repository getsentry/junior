import type { ReactNode } from "react";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { cn } from "@dashboard/lib/utils";

/** Own the chosen value and the open state of a list of options. */
function Select<Value>(props: SelectPrimitive.Root.Props<Value>) {
  return <SelectPrimitive.Root {...props} />;
}

/** Open the options from a compact control that shows the chosen value. */
function SelectTrigger({
  className,
  children,
  ...props
}: SelectPrimitive.Trigger.Props) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        "inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-dashboard-border-emphasis bg-dashboard-surface-panel pr-2 pl-2.5 font-sans text-xs font-medium whitespace-nowrap text-dashboard-text-muted transition-colors outline-none select-none md:h-8 hover:border-dashboard-border-interactive hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus disabled:cursor-not-allowed disabled:opacity-60 data-popup-open:text-dashboard-text [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon className="flex">
        <ChevronDownIcon aria-hidden="true" className="size-3.5" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

/** Show the chosen value inside the trigger. */
function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={cn("flex items-center gap-1.5", className)}
      {...props}
    />
  );
}

/** Position the options next to the trigger on the popover surface. */
function SelectContent({
  className,
  children,
  align = "start",
  side = "bottom",
  ...props
}: SelectPrimitive.Popup.Props &
  Pick<SelectPrimitive.Positioner.Props, "align" | "side">) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        align={align}
        alignItemWithTrigger={false}
        className="isolate z-50"
        side={side}
        sideOffset={6}
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          className={cn(
            "max-h-(--available-height) max-w-[calc(100vw-2rem)] min-w-(--anchor-width) origin-(--transform-origin) overflow-y-auto rounded-lg border border-dashboard-border-emphasis bg-dashboard-surface-raised p-1 text-sm text-dashboard-text shadow-lg outline-none transition-[opacity,scale] duration-150 motion-reduce:transition-none data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0",
            className,
          )}
          {...props}
        >
          <SelectPrimitive.List>{children}</SelectPrimitive.List>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

/** Offer one value, with an optional line that explains it. */
function SelectItem({
  className,
  children,
  description,
  ...props
}: SelectPrimitive.Item.Props & { description?: ReactNode }) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "relative grid cursor-pointer gap-0.5 rounded-md py-1.5 pr-8 pl-2 outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-dashboard-fill-hover",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText className="flex items-center gap-2 font-medium [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-dashboard-text-muted">
        {children}
      </SelectPrimitive.ItemText>
      {description ? (
        <span className="pl-5.5 text-xs text-dashboard-text-muted">
          {description}
        </span>
      ) : null}
      <SelectPrimitive.ItemIndicator className="absolute top-2 right-2 flex size-4 items-center justify-center">
        <CheckIcon aria-hidden="true" className="size-3.5" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

export { Select, SelectContent, SelectItem, SelectTrigger, SelectValue };
