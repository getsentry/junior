import type { ComponentProps } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { cn } from "@dashboard/lib/utils";

import { Button } from "@dashboard/components/ui/button";

/** Mark a page control group as navigation. */
function Pagination({ className, ...props }: ComponentProps<"nav">) {
  return (
    <nav
      role="navigation"
      aria-label="Pagination"
      data-slot="pagination"
      className={cn("flex w-full justify-center", className)}
      {...props}
    />
  );
}

/** Hold the page controls as a list. */
function PaginationContent({ className, ...props }: ComponentProps<"ul">) {
  return (
    <ul
      data-slot="pagination-content"
      className={cn("flex items-center gap-2", className)}
      {...props}
    />
  );
}

/** Hold one page control. */
function PaginationItem({ ...props }: ComponentProps<"li">) {
  return <li data-slot="pagination-item" {...props} />;
}

/** Go to the previous page. */
function PaginationPrevious(props: ComponentProps<typeof Button>) {
  return (
    <Button aria-label="Previous page" size="icon" {...props}>
      <ChevronLeftIcon aria-hidden="true" size={16} />
    </Button>
  );
}

/** Go to the next page. */
function PaginationNext(props: ComponentProps<typeof Button>) {
  return (
    <Button aria-label="Next page" size="icon" {...props}>
      <ChevronRightIcon aria-hidden="true" size={16} />
    </Button>
  );
}

export {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
};
