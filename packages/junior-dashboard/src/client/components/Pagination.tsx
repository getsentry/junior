import { ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "../styles";
import { Button } from "./Button";

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
    <div
      aria-label="Pagination"
      className={cn(
        "flex flex-wrap items-center justify-between gap-3",
        props.className,
      )}
    >
      <p className="m-0 font-mono text-xs text-dashboard-text-muted">
        Showing {start.toLocaleString("en-US")}-{end.toLocaleString("en-US")} of{" "}
        {props.total.toLocaleString("en-US")}
      </p>
      <div className="flex items-center gap-2">
        <Button
          aria-label="Previous page"
          disabled={current <= 1}
          onClick={() => props.onPageChange(current - 1)}
          size="icon"
        >
          <ChevronLeft aria-hidden="true" size={16} />
        </Button>
        <span className="min-w-16 text-center font-mono text-xs text-dashboard-text-muted">
          {current} / {props.pageCount}
        </span>
        <Button
          aria-label="Next page"
          disabled={current >= props.pageCount}
          onClick={() => props.onPageChange(current + 1)}
          size="icon"
        >
          <ChevronRight aria-hidden="true" size={16} />
        </Button>
      </div>
    </div>
  );
}
