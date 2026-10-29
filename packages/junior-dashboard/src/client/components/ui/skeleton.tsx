import type { ComponentProps } from "react";
import { cn } from "@dashboard/lib/utils";

/** Hide one content placeholder from assistive technology. */
function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      aria-hidden="true"
      data-slot="skeleton"
      className={cn(
        "animate-pulse rounded-md bg-dashboard-fill-soft motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
