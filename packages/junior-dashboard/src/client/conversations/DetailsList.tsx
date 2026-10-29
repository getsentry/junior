import { ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn, dashboardDisclosureChevronClass } from "../styles";

/** Rows a details list shows before the reader asks for the rest. */
const COLLAPSED_ROW_COUNT = 3;

/**
 * Show rows in a details card. Rows are split by thin rules. A list with more
 * than three rows shows the first three and a row that shows the rest.
 */
export function DetailsList<T>(props: {
  items: readonly T[];
  itemKey(item: T): string;
  renderItem(item: T): ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const hidden = props.items.length - COLLAPSED_ROW_COUNT;
  const visible =
    expanded || hidden <= 0
      ? props.items
      : props.items.slice(0, COLLAPSED_ROW_COUNT);

  return (
    // Rows own their padding, so hover fills reach the rules. The negative
    // margin keeps the first and last text on the card padding.
    <ul className="-my-2.5 grid list-none p-0">
      {visible.map((item) => (
        <li
          className="border-t border-dashboard-border-subtle first:border-t-0"
          key={props.itemKey(item)}
        >
          {props.renderItem(item)}
        </li>
      ))}
      {hidden > 0 ? (
        <li className="border-t border-dashboard-border-subtle">
          <button
            aria-expanded={expanded}
            className="group -mx-2 flex min-h-8 items-center gap-2.5 rounded-md px-2 py-2 text-left text-xs font-medium leading-4 text-dashboard-text-muted transition-colors hover:bg-dashboard-surface-hover hover:text-dashboard-text focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus"
            onClick={() => setExpanded((value) => !value)}
            type="button"
          >
            <span className="grid size-4 shrink-0 place-items-center">
              <ChevronRight
                aria-hidden="true"
                className={dashboardDisclosureChevronClass}
              />
            </span>
            {expanded ? "Show fewer" : `Show ${hidden} more`}
          </button>
        </li>
      ) : null}
    </ul>
  );
}

/**
 * Lay out one details list row: an icon, a title, and short trailing text on
 * the first line, then optional lines under the title. A row with `href`
 * opens that link in a new tab.
 */
export function DetailsRow(props: {
  children?: ReactNode;
  href?: string;
  icon: ReactNode;
  meta?: ReactNode;
  title: ReactNode;
  /** Native hover text with detail that the row does not show. */
  tooltip?: string;
}) {
  const className = cn(
    "-mx-2 grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2.5 gap-y-1 rounded-md px-2 py-2.5 text-inherit no-underline",
    props.href &&
      "group transition-colors hover:bg-dashboard-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus",
  );
  const content = (
    <>
      <span className="grid size-5 shrink-0 place-items-center text-dashboard-text-muted">
        {props.icon}
      </span>
      <span className="min-w-0 truncate text-sm font-medium leading-5 text-dashboard-text group-hover:underline">
        {props.title}
      </span>
      <span className="shrink-0 text-xs leading-5 tabular-nums text-dashboard-text-muted">
        {props.meta}
      </span>
      {props.children}
    </>
  );
  return props.href ? (
    <a
      className={className}
      href={props.href}
      rel="noreferrer"
      target="_blank"
      title={props.tooltip}
    >
      {content}
    </a>
  ) : (
    <div className={className} title={props.tooltip}>
      {content}
    </div>
  );
}

/** Place one extra line under the title of a `DetailsRow`. */
export function DetailsRowLine(props: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "col-start-2 col-end-4 min-w-0 text-xs leading-4 text-dashboard-text-muted",
        props.className,
      )}
    >
      {props.children}
    </div>
  );
}
