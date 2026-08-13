import type { ReactNode } from "react";
import { Link } from "react-router";

import { cn } from "../../styles";
import { DirectoryRowsSkeleton } from "./DirectoryRowsSkeleton";

const directoryGridClass =
  "grid-cols-[minmax(14rem,1fr)_repeat(2,minmax(5rem,auto))_minmax(8rem,auto)]";

/** Lay out directory search and sort controls above a result table. */
export function DirectoryToolbar(props: {
  children: ReactNode;
  columnsClassName: string;
}) {
  return (
    <div
      className={cn(
        "grid min-w-0 gap-2 border-b border-dashboard-border-subtle bg-dashboard-overlay-soft p-3",
        props.columnsClassName,
      )}
    >
      {props.children}
    </div>
  );
}

/** Render the shared loading, empty, heading, and row structure for directories. */
export function DirectoryTable(props: {
  ariaLabel: string;
  children: ReactNode;
  empty?: ReactNode;
  headers: readonly string[];
  loading?: boolean;
}) {
  if (props.loading) {
    return <DirectoryRowsSkeleton wideRuntime />;
  }
  if (props.empty) {
    return <div className="p-4">{props.empty}</div>;
  }
  return (
    <div aria-label={props.ariaLabel} className="min-w-0">
      <div
        aria-hidden="true"
        className={cn(
          "grid items-center gap-4 border-b border-dashboard-border-subtle bg-dashboard-overlay px-4 py-2.5 font-mono text-xs uppercase tracking-[0.1em] text-dashboard-text-muted max-md:hidden",
          directoryGridClass,
        )}
      >
        {props.headers.map((header, index) => (
          <div className={index ? "justify-self-end" : undefined} key={header}>
            {header}
          </div>
        ))}
      </div>
      {props.children}
    </div>
  );
}

/** Render one linked directory result with the shared responsive grid. */
export function DirectoryRow(props: { children: ReactNode; to: string }) {
  return (
    <Link
      className={cn(
        "group grid min-w-0 items-center gap-4 border-b border-dashboard-border-row px-4 py-3.5 text-inherit no-underline transition-colors last:border-b-0 hover:bg-dashboard-fill-muted max-md:grid-cols-3 max-md:gap-x-3 max-md:gap-y-4",
        directoryGridClass,
      )}
      to={props.to}
    >
      {props.children}
    </Link>
  );
}

/** Render the leading icon, title, and supporting text for a directory row. */
export function DirectoryIdentity(props: {
  description?: ReactNode;
  icon: ReactNode;
  iconClassName: string;
  title: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 max-md:col-span-3">
      <span
        className={cn(
          "grid size-9 shrink-0 place-items-center rounded border border-dashboard-border-strong transition-colors",
          props.iconClassName,
        )}
      >
        {props.icon}
      </span>
      <div className="min-w-0">
        <div className="truncate font-display text-base font-medium leading-tight text-dashboard-text">
          {props.title}
        </div>
        {props.description ? (
          <div className="mt-1 truncate font-mono text-xs leading-tight text-dashboard-text-muted">
            {props.description}
          </div>
        ) : null}
      </div>
    </div>
  );
}
