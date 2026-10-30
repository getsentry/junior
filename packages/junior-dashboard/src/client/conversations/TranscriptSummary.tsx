import type { ComponentProps } from "react";

import { CollapsibleTrigger } from "../components/ui/collapsible";
import { cn } from "../styles";

/**
 * Give a `Collapsible` trigger the padding, hover, and keyboard focus of a
 * transcript disclosure. The caller sets the display. Put only inline
 * elements, such as `span`, inside the trigger.
 */
export function TranscriptSummaryTrigger({
  className,
  flush = false,
  ...props
}: Omit<ComponentProps<typeof CollapsibleTrigger>, "className"> & {
  className?: string;
  /** Extend padding around text that already sits on the transcript edge. */
  flush?: boolean;
}) {
  return (
    <CollapsibleTrigger
      {...props}
      className={cn(
        "cursor-pointer rounded-md px-2 py-1.5 text-left transition-colors hover:bg-dashboard-fill-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus disabled:cursor-default disabled:hover:bg-transparent",
        flush ? "-mx-2 -my-1.5 w-[calc(100%+1rem)]" : "w-full",
        className,
      )}
    />
  );
}
