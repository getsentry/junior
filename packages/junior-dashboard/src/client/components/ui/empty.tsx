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

/** Hold the icon that names the kind of empty state. */
function EmptyMedia({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      aria-hidden="true"
      data-slot="empty-media"
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-md bg-dashboard-fill-strong text-dashboard-text-subtle [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

/** Name the empty state in a few words. */
function EmptyTitle({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-title"
      className={cn(
        "font-display text-base font-medium leading-tight text-dashboard-text",
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

export { Empty, EmptyDescription, EmptyMedia, EmptyTitle };
