import { lazy, Suspense, useState, type CSSProperties } from "react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { useMobileLayout } from "@dashboard/layoutMedia";
import { cn } from "@dashboard/lib/utils";

import {
  PHONE_SHEET_POPUP_CLASS,
  PHONE_SHEET_POSITIONER_CLASS,
} from "./phoneSheet";

const PhoneSheetBand = lazy(() =>
  import("./phoneSheetBand").then((module) => ({
    default: module.PhoneSheetBand,
  })),
);

/**
 * Own an anchored popover's state and dismissal. A phone shows it as a
 * modal sheet, so a tap on the dimmed page only closes it.
 */
export function Popover(props: PopoverPrimitive.Root.Props) {
  const mobile = useMobileLayout();
  return <PopoverPrimitive.Root {...props} modal={mobile || props.modal} />;
}

/** Open a popover from the owning control. */
export function PopoverTrigger(props: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

/**
 * Position popover content within the viewport and share its themed surface.
 * A phone shows it as a sheet on the bottom edge, above the keyboard while
 * it is open.
 */
export function PopoverContent({
  className,
  align = "center",
  side = "bottom",
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<PopoverPrimitive.Positioner.Props, "align" | "side">) {
  // A popover can hold a field, such as a comment or a search, so a phone
  // keeps it above the keyboard.
  const mobile = useMobileLayout();
  const [bandStyle, setBandStyle] = useState<CSSProperties>();
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        align={align}
        side={side}
        sideOffset={8}
        className={cn("isolate z-50", PHONE_SHEET_POSITIONER_CLASS)}
        style={mobile ? bandStyle : undefined}
      >
        {mobile ? (
          <Suspense fallback={null}>
            <PhoneSheetBand onChange={setBandStyle} />
          </Suspense>
        ) : null}
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            "w-80 max-w-[calc(100vw-2rem)] max-h-(--available-height) origin-(--transform-origin) overflow-y-auto rounded-lg border border-input bg-secondary p-4 text-sm text-foreground shadow-lg outline-none focus-visible:outline-2 focus-visible:outline-ring transition-[opacity,scale] duration-180 motion-reduce:transition-none data-ending-style:opacity-0 data-starting-style:opacity-0 data-ending-style:scale-95 data-starting-style:scale-95",
            className,
            PHONE_SHEET_POPUP_CLASS,
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
      className={cn("m-0 leading-relaxed text-muted-foreground", className)}
      {...props}
    />
  );
}
