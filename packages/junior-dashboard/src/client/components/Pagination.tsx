import { cn } from "../styles";
import { Button } from "./ui/button";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "./ui/pagination";

/** Render a centered load-more control for cursor or progressive lists. */
export function LoadMorePagination(props: {
  className?: string;
  hasMore: boolean;
  loading?: boolean;
  onLoadMore(): void;
}) {
  if (!props.hasMore) return null;
  return (
    <Button
      className={cn("justify-self-center", props.className)}
      disabled={props.loading}
      onClick={props.onLoadMore}
    >
      {props.loading ? "Loading…" : "Load more"}
    </Button>
  );
}

/** Slice one page from a finite list for shared client-side pagination. */
export function pageItems<T>(
  items: readonly T[],
  page: number,
  pageSize: number,
): T[] {
  const safePage = Math.max(1, page);
  const start = (safePage - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

/** Count pages for a finite list. */
export function pageCount(total: number, pageSize: number): number {
  if (total <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

/** Render numbered page controls for finite client-side lists. */
export function PagePagination(props: {
  className?: string;
  onPageChange(page: number): void;
  page: number;
  pageCount: number;
  pageSize: number;
  total: number;
}) {
  if (props.total <= props.pageSize || props.pageCount <= 1) return null;
  const current = Math.min(Math.max(1, props.page), props.pageCount);
  const start = (current - 1) * props.pageSize + 1;
  const end = Math.min(props.total, current * props.pageSize);

  return (
    <Pagination
      className={cn(
        "flex-wrap items-center justify-between gap-3",
        props.className,
      )}
    >
      <p className="m-0 font-sans tabular-nums text-xs text-dashboard-text-muted">
        Showing {start.toLocaleString("en-US")}-{end.toLocaleString("en-US")} of{" "}
        {props.total.toLocaleString("en-US")}
      </p>
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious
            disabled={current <= 1}
            onClick={() => props.onPageChange(current - 1)}
          />
        </PaginationItem>
        <PaginationItem className="min-w-16 text-center font-sans tabular-nums text-xs text-dashboard-text-muted">
          {current} / {props.pageCount}
        </PaginationItem>
        <PaginationItem>
          <PaginationNext
            disabled={current >= props.pageCount}
            onClick={() => props.onPageChange(current + 1)}
          />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}
