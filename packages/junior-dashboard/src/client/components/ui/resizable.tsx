import * as ResizablePrimitive from "react-resizable-panels";
import { cn } from "@dashboard/lib/utils";

/** Lay out resizable panels in one row or column. */
function ResizablePanelGroup({
  className,
  ...props
}: ResizablePrimitive.GroupProps) {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      className={cn(
        "flex h-full w-full aria-[orientation=vertical]:flex-col",
        className,
      )}
      {...props}
    />
  );
}

/** A panel size that follows the reader's font size, as the text inside does. */
type RemSize = `${number}rem`;

/**
 * A rem or percent size, or 0 for a collapsed panel. A px size does not grow
 * with the browser font size, so it stops fitting the rem-sized content.
 */
type PanelSize = RemSize | `${number}%` | 0;

type PanelProps = Omit<
  ResizablePrimitive.PanelProps,
  "collapsedSize" | "defaultSize" | "maxSize" | "minSize"
> & {
  collapsedSize?: PanelSize;
  defaultSize?: PanelSize;
  maxSize?: PanelSize;
  minSize?: PanelSize;
};

/** Hold one resizable region inside a panel group. */
function ResizablePanel({ ...props }: PanelProps) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />;
}

/** Drag or use arrow keys to resize the panels on each side. */
function ResizableHandle({
  withHandle,
  className,
  ...props
}: ResizablePrimitive.SeparatorProps & {
  withHandle?: boolean;
}) {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        "relative flex w-px items-center justify-center bg-border ring-offset-background after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-1 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2 [&[aria-orientation=horizontal]>div]:rotate-90",
        className,
      )}
      {...props}
    >
      {withHandle && (
        <div className="z-10 flex h-6 w-1 shrink-0 rounded-lg bg-border" />
      )}
    </ResizablePrimitive.Separator>
  );
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup };
export type { RemSize };
