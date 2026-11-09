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
          "size-full overscroll-contain outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-dashboard-focus",
          viewportClassName,
        )}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar
        data-slot="scroll-area-scrollbar"
        className="flex h-full w-2 touch-none p-px opacity-0 transition-opacity delay-500 duration-300 select-none hover:opacity-100 hover:delay-0 data-scrolling:opacity-100 data-scrolling:delay-0 data-scrolling:duration-75 motion-reduce:transition-none"
      >
        <ScrollAreaPrimitive.Thumb className="flex-1 rounded-full bg-dashboard-scrollbar-thumb hover:bg-dashboard-scrollbar-thumb-hover" />
      </ScrollAreaPrimitive.Scrollbar>
    </ScrollAreaPrimitive.Root>
  );
}

export { ScrollArea };
