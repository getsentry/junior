import type { ComponentPropsWithoutRef } from "react";

import { cn } from "../styles";

/** Keep transcript hover quiet and mark keyboard focus beside the row. */
export function TranscriptSummary({
  className,
  ...props
}: ComponentPropsWithoutRef<"summary">) {
  return (
    <summary
      {...props}
      className={cn(
        "relative cursor-pointer list-none rounded transition-colors hover:bg-dashboard-fill-hover focus-visible:bg-dashboard-fill-hover focus-visible:outline-hidden focus-visible:before:absolute focus-visible:before:inset-y-1 focus-visible:before:-left-1.5 focus-visible:before:w-0.5 focus-visible:before:rounded-full focus-visible:before:bg-dashboard-focus [&::-webkit-details-marker]:hidden",
        className,
      )}
    />
  );
}
