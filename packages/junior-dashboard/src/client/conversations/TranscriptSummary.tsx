import type { ComponentProps, ComponentPropsWithoutRef } from "react";

import { CollapsibleTrigger } from "../components/ui/collapsible";
import { cn } from "../styles";

const summaryClass =
  "cursor-pointer rounded-md px-2 py-1.5 transition-colors hover:bg-dashboard-fill-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus";

/** Keep hover and keyboard focus around a padded transcript cell. */
export function TranscriptSummary({
  className,
  flush = false,
  ...props
}: ComponentPropsWithoutRef<"summary"> & {
  /** Extend padding around text that already sits on the transcript edge. */
  flush?: boolean;
}) {
  return (
    <summary
      {...props}
      className={cn(
        summaryClass,
        "list-none [&::-webkit-details-marker]:hidden",
        flush && "-mx-2 -my-1.5",
        className,
      )}
    />
  );
}

/**
 * Give a `Collapsible` trigger the same padding, hover, and focus as
 * `TranscriptSummary`. The caller sets the display. Put only inline elements,
 * such as `span`, inside the trigger.
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
        summaryClass,
        "text-left disabled:cursor-default disabled:hover:bg-transparent",
        flush ? "-mx-2 -my-1.5 w-[calc(100%+1rem)]" : "w-full",
        className,
      )}
    />
  );
}
