import type { ComponentPropsWithoutRef } from "react";

import { cn } from "../styles";

/** Keep hover and keyboard focus around a padded transcript cell. */
export function TranscriptSummary({
  className,
  ...props
}: ComponentPropsWithoutRef<"summary">) {
  return (
    <summary
      {...props}
      className={cn(
        "cursor-pointer list-none rounded-md px-2 py-1.5 transition-colors hover:bg-dashboard-fill-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus [&::-webkit-details-marker]:hidden",
        className,
      )}
    />
  );
}
