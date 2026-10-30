import type { ComponentProps } from "react";
import { cn } from "@dashboard/lib/utils";

/** Frame an empty state inside a page or list region. */
function Empty({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="empty"
      className={cn(
        "min-w-0 rounded-lg border border-dashboard-border-strong bg-dashboard-bg px-4 py-3",
        className,
      )}
      {...props}
    />
  );
}

/** Explain why the region is empty and what the user can do next. */
function EmptyDescription({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-description"
      className={cn(
        "text-base leading-relaxed text-dashboard-text-muted",
        className,
      )}
      {...props}
    />
  );
}

export { Empty, EmptyDescription };
