import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import { cn } from "@dashboard/lib/utils";

type ScrollAreaProps = ScrollAreaPrimitive.Root.Props & {
  viewportClassName?: string;
};

/**
 * Vertical scroll container whose overlay scrollbar stays hidden at rest and
 * appears while scrolling or when the pointer is on it.
 */
function ScrollArea({
  className,
  children,
  viewportClassName,
  ...props
}: ScrollAreaProps) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative min-h-0", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className={cn(
          "size-full overscroll-contain outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
          viewportClassName,
        )}
      >
        {/* The viewport sees only its own size changes. Content also sees
            rows that load later, so the scrollbar shows when they overflow.
            This area scrolls only down, so remove the fit-content minimum
            width of Content. Then long rows truncate. */}
        <ScrollAreaPrimitive.Content style={{ minWidth: 0 }}>
          {children}
        </ScrollAreaPrimitive.Content>
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar
        data-slot="scroll-area-scrollbar"
        className="flex h-full w-1.5 touch-none px-px opacity-0 transition-opacity delay-500 duration-300 select-none hover:opacity-100 hover:delay-0 data-scrolling:opacity-100 data-scrolling:delay-0 data-scrolling:duration-75 motion-reduce:transition-none"
      >
        <ScrollAreaPrimitive.Thumb className="flex-1 rounded-full bg-dashboard-scrollbar-thumb/80 hover:bg-dashboard-scrollbar-thumb-hover" />
      </ScrollAreaPrimitive.Scrollbar>
    </ScrollAreaPrimitive.Root>
  );
}

export { ScrollArea };
