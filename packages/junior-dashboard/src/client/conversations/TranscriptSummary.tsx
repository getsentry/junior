import type { ComponentPropsWithoutRef } from "react";

import { cn } from "../styles";

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
        "cursor-pointer list-none rounded-md px-2 py-1.5 transition-colors hover:bg-dashboard-fill-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus [&::-webkit-details-marker]:hidden",
        flush && "-mx-2 -my-1.5",
        className,
      )}
    />
  );
}
