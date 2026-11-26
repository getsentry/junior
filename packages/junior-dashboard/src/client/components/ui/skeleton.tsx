import type { ComponentProps } from "react";
import { cn } from "@dashboard/lib/utils";

const boneClassName =
  "animate-pulse rounded-md bg-dashboard-fill-soft motion-reduce:animate-none";

/** Hide one content placeholder from assistive technology. */
function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      aria-hidden="true"
      data-slot="skeleton"
      className={cn(boneClassName, className)}
      {...props}
    />
  );
}

/**
 * Hold a run of text that is still loading. It sits on the baseline at about
 * cap height, so its line keeps the height that real text gives it.
 */
function SkeletonText({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      aria-hidden="true"
      data-slot="skeleton"
      className={cn(
        boneClassName,
        "inline-block h-[0.8em] rounded-sm align-baseline",
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton, SkeletonText };
