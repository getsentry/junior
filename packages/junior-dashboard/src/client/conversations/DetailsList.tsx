import { ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn, dashboardDisclosureChevronClass } from "../styles";

/**
 * Group one kind of detail in a compact card. Conversation details and event
 * details share it, so both panels read the same way. A `label` names the
 * card as a region.
 */
export function DetailsCard(props: {
  children: ReactNode;
  count?: number;
  label?: string;
  title?: string;
}) {
  return (
    <section
      aria-label={props.label}
      className="grid min-w-0 gap-2.5 rounded-lg border border-dashboard-border-subtle bg-dashboard-surface-panel p-3"
    >
      {props.title ? (
        <h3 className="m-0 flex min-w-0 items-center gap-1.5 break-words font-sans text-xs font-medium text-dashboard-text-muted">
          {props.title}
          {props.count ? (
            <span className="tabular-nums text-dashboard-text-faint">
              {props.count.toLocaleString("en-US")}
            </span>
          ) : null}
        </h3>
      ) : null}
      <div className="min-w-0 break-words font-sans text-xs leading-relaxed text-dashboard-text-muted">
        {props.children}
      </div>
    </section>
  );
}

/** Rows a details list shows before the reader asks for the rest. */
const COLLAPSED_ROW_COUNT = 3;

/**
 * Show rows in a details card. A list with more than three rows shows the
 * first three and a row that shows the rest.
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
    // Rows own their padding, so a hover fill sits inside the card with an
    // even inset. The negative margins keep row text on the card padding.
    <ul className="-mx-1.5 -mb-1.5 -mt-1 grid list-none gap-0.5 p-0">
      {visible.map((item) => (
        <li key={props.itemKey(item)}>{props.renderItem(item)}</li>
      ))}
      {hidden > 0 ? (
        <li>
          <button
            aria-expanded={expanded}
            className="group flex min-h-8 w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left text-xs font-medium leading-4 text-dashboard-text-muted transition-colors hover:bg-dashboard-surface-hover hover:text-dashboard-text focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus"
            onClick={() => setExpanded((value) => !value)}
            type="button"
          >
            <span className="grid size-5 shrink-0 place-items-center">
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
 * opens that link in a new tab. A row with `onToggle` is a disclosure button
 * that shows or hides content the caller renders under it.
 */
export function DetailsRow(props: {
  children?: ReactNode;
  expanded?: boolean;
  href?: string;
  icon: ReactNode;
  meta?: ReactNode;
  onToggle?(): void;
  title: ReactNode;
  /** Native hover text with detail that the row does not show. */
  tooltip?: string;
}) {
  const interactive = props.href !== undefined || props.onToggle !== undefined;
  const className = cn(
    "grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2.5 gap-y-1 rounded-md px-1.5 py-1.5 text-left text-inherit no-underline",
    interactive &&
      "group transition-colors hover:bg-dashboard-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus",
  );
  const content = (
    <>
      <span className="grid size-5 shrink-0 place-items-center text-dashboard-text-muted">
        {props.icon}
      </span>
      <span className="min-w-0 truncate text-sm font-medium leading-5 text-dashboard-text">
        {props.title}
      </span>
      <span className="shrink-0 text-xs leading-5 tabular-nums text-dashboard-text-muted">
        {props.meta}
      </span>
      {props.children}
    </>
  );
  if (props.href) {
    return (
      <a
        className={className}
        href={props.href}
        rel="noreferrer"
        target="_blank"
        title={props.tooltip}
      >
        {content}
      </a>
    );
  }
  if (props.onToggle) {
    return (
      <button
        aria-expanded={props.expanded ?? false}
        className={className}
        onClick={props.onToggle}
        title={props.tooltip}
        type="button"
      >
        {content}
      </button>
    );
  }
  return (
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
