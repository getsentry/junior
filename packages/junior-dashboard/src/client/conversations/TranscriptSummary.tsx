import type { ComponentPropsWithoutRef } from "react";

import { cn } from "../styles";

/** Give transcript disclosures a quiet hover fill and a clear text focus mark. */
export function TranscriptSummary({
  className,
  ...props
}: ComponentPropsWithoutRef<"summary">) {
  return (
    <summary
      {...props}
      className={cn(
        "cursor-pointer list-none rounded transition-colors hover:bg-dashboard-fill-hover focus-visible:bg-dashboard-fill-hover focus-visible:outline-hidden focus-visible:underline focus-visible:decoration-dashboard-focus focus-visible:decoration-2 focus-visible:underline-offset-4 [&::-webkit-details-marker]:hidden",
        className,
      )}
    />
  );
}
