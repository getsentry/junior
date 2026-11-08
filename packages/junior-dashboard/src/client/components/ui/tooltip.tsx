import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { cva, type VariantProps } from "class-variance-authority";
import {
  createContext,
  useContext,
  useId,
  useState,
  useSyncExternalStore,
  type ComponentProps,
} from "react";
import { cn } from "@dashboard/lib/utils";

/** Open dashboard tooltips at once and keep them open briefly for the pointer to reach them. */
function TooltipProvider({
  delay = 0,
  closeDelay = 150,
  ...props
}: TooltipPrimitive.Provider.Props) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delay={delay}
      closeDelay={closeDelay}
      {...props}
    />
  );
}

/** Link the open popup to its trigger. Base UI leaves this to the app. */
const TooltipDescriptionContext = createContext<string | undefined>(undefined);

/**
 * Wide screens with a fine hover pointer show tooltips. On smaller or touch
 * screens, a tooltip can cover the menu that its trigger opens.
 */
const TOOLTIP_MEDIA_QUERY =
  "(min-width: 768px) and (hover: hover) and (pointer: fine)";

function subscribeToTooltipMedia(onChange: () => void) {
  const media = window.matchMedia(TOOLTIP_MEDIA_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function tooltipMediaMatches() {
  return window.matchMedia(TOOLTIP_MEDIA_QUERY).matches;
}

/** Own one tooltip's open state. It stays off where tooltips are not shown. */
function Tooltip({
  disabled,
  onOpenChange,
  open: openProp,
  ...props
}: TooltipPrimitive.Root.Props) {
  const available = useSyncExternalStore(
    subscribeToTooltipMedia,
    tooltipMediaMatches,
    () => false,
  );
  const id = useId();
  const [openState, setOpenState] = useState(props.defaultOpen ?? false);
  const open = available && (openProp ?? openState);
  return (
    <TooltipDescriptionContext.Provider value={open ? id : undefined}>
      <TooltipPrimitive.Root
        data-slot="tooltip"
        disabled={disabled || !available}
        onOpenChange={(next, details) => {
          setOpenState(next);
          onOpenChange?.(next, details);
        }}
        open={openProp}
        {...props}
      />
    </TooltipDescriptionContext.Provider>
  );
}

/**
 * Show the tooltip on mouse hover or keyboard focus. Touch does not open it.
 * A click keeps it open, so copy and share feedback stays visible.
 */
function TooltipTrigger({
  closeOnClick = false,
  ...props
}: TooltipPrimitive.Trigger.Props) {
  const describedBy = useContext(TooltipDescriptionContext);
  return (
    <TooltipPrimitive.Trigger
      aria-describedby={describedBy}
      closeOnClick={closeOnClick}
      data-slot="tooltip-trigger"
      {...props}
    />
  );
}

const tooltipContentVariants = cva(
  "z-50 select-text rounded-md border border-dashboard-border-emphasis bg-dashboard-surface-raised font-sans text-xs shadow-2xl shadow-black/70 outline-none",
  {
    variants: {
      size: {
        /** Selectable detail cards, such as chart buckets and metric breakdowns. */
        default:
          "min-w-36 max-w-lg px-3 py-2 leading-relaxed text-dashboard-text-muted",
        /** One short label for an icon-only control. */
        compact: "px-2.5 py-1.5 leading-none text-dashboard-text",
      },
    },
    defaultVariants: { size: "default" },
  },
);

/** Show tooltip text beside its trigger and keep it inside the viewport. */
function TooltipContent({
  className,
  side = "top",
  sideOffset = 10,
  align = "center",
  size,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<TooltipPrimitive.Positioner.Props, "align" | "side" | "sideOffset"> &
  VariantProps<typeof tooltipContentVariants>) {
  const id = useContext(TooltipDescriptionContext);
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        collisionPadding={8}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-50 data-anchor-hidden:invisible"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          id={id}
          role="tooltip"
          className={cn(tooltipContentVariants({ size }), className)}
          {...props}
        >
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

/** Name what a detail tooltip describes, such as a chart bucket date. */
function TooltipTitle({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("mb-1 font-semibold text-dashboard-text-muted", className)}
      {...props}
    />
  );
}

export {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipTitle,
  TooltipProvider,
  tooltipContentVariants,
};
