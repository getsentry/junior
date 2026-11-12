import type { ComponentProps } from "react";
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { ChevronRight } from "lucide-react";
import { cn } from "@dashboard/lib/utils";

/** Name the trail of pages above the current page. */
function Breadcrumb({ ...props }: ComponentProps<"nav">) {
  return <nav aria-label="Breadcrumb" data-slot="breadcrumb" {...props} />;
}

/** List the trail on one line. Long labels truncate instead of wrapping. */
function BreadcrumbList({ className, ...props }: ComponentProps<"ol">) {
  return (
    <ol
      data-slot="breadcrumb-list"
      className={cn(
        "m-0 flex min-w-0 list-none items-center gap-1.5 p-0 text-sm text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

/** Hold one page of the trail. */
function BreadcrumbItem({ className, ...props }: ComponentProps<"li">) {
  return (
    <li
      data-slot="breadcrumb-item"
      className={cn("inline-flex min-w-0 items-center gap-1.5", className)}
      {...props}
    />
  );
}

/** Link to a page above the current page. */
function BreadcrumbLink({
  className,
  render,
  ...props
}: useRender.ComponentProps<"a">) {
  return useRender({
    defaultTagName: "a",
    props: mergeProps<"a">(
      {
        className: cn(
          "min-w-0 truncate font-sans no-underline underline-offset-2 transition-colors hover:text-foreground hover:underline",
          className,
        ),
      },
      props,
    ),
    render,
    state: {
      slot: "breadcrumb-link",
    },
  });
}

/** Divide two pages of the trail. */
function BreadcrumbSeparator({ className, ...props }: ComponentProps<"li">) {
  return (
    <li
      data-slot="breadcrumb-separator"
      role="presentation"
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 text-dashboard-text-faint",
        className,
      )}
      {...props}
    >
      <ChevronRight size={14} />
    </li>
  );
}

export {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
};
