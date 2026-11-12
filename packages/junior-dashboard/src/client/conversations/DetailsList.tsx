import { ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";

import { CollapsibleTrigger } from "../components/ui/collapsible";
import { Button } from "../components/ui/button";
import { Item, ItemContent, ItemMedia } from "../components/ui/item";
import { cn, dashboardDisclosureChevronClass } from "../styles";
import { OutboundIcon } from "../components/OutboundLink";

/**
 * Group one kind of detail in a compact card. Conversation details and event
 * details share it, so both panels read the same way. A `label` names the
 * card as a region. An `action` sits at the end of the title row.
 */
export function DetailsCard(props: {
  action?: ReactNode;
  children: ReactNode;
  count?: number;
  flat?: boolean;
  label?: string;
  title?: string;
}) {
  return (
    <section
      aria-label={props.label}
      className={cn(
        "grid min-w-0 border-dashboard-border-subtle",
        props.flat
          ? "gap-1.5 border-t px-1 pt-3 pb-1"
          : "gap-2.5 rounded-lg border bg-dashboard-surface-panel p-3",
      )}
    >
      {props.title ? (
        <div className="flex min-w-0 items-center justify-between gap-2">
          <h3
            className={cn(
              "m-0 flex min-w-0 items-center gap-1.5 break-words font-sans text-xs",
              props.flat
                ? "font-semibold text-dashboard-text"
                : "font-medium text-dashboard-text-muted",
            )}
          >
            {props.title}
            {props.count ? (
              <span className="font-normal tabular-nums text-dashboard-text-faint">
                {props.count.toLocaleString("en-US")}
              </span>
            ) : null}
          </h3>
          {props.action}
        </div>
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
          <Button
            aria-expanded={expanded}
            className="group flex min-h-8 w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left text-xs font-medium leading-4 focus-visible:-outline-offset-2"
            onClick={() => setExpanded((value) => !value)}
            variant="ghost"
            size="bare"
          >
            <span className="grid size-5 shrink-0 place-items-center">
              <ChevronRight
                aria-hidden="true"
                className={dashboardDisclosureChevronClass}
              />
            </span>
            {expanded ? "Show fewer" : `Show ${hidden} more`}
          </Button>
        </li>
      ) : null}
    </ul>
  );
}

/**
 * Lay out one details list row: an icon, a title, and short trailing text on
 * the first line, then optional lines under the title. A row with `href`
 * opens that link in a new tab, and a row with `to` opens a dashboard page.
 * An `onClick` row is a button. A `disclosure` row is the trigger of the
 * enclosing `Collapsible`, so it shows or hides the content under it.
 */
export function DetailsRow(props: {
  children?: ReactNode;
  disclosure?: boolean;
  href?: string;
  icon: ReactNode;
  meta?: ReactNode;
  onClick?(): void;
  title: ReactNode;
  to?: string;
  /** Native hover text with detail that the row does not show. */
  tooltip?: string;
}) {
  const interactive =
    props.href !== undefined ||
    props.to !== undefined ||
    props.onClick !== undefined ||
    props.disclosure === true;
  const render = props.href ? (
    <a href={props.href} rel="noreferrer" target="_blank" />
  ) : props.to ? (
    <Link to={props.to} />
  ) : props.onClick ? (
    <button onClick={props.onClick} type="button" />
  ) : props.disclosure ? (
    <CollapsibleTrigger />
  ) : undefined;
  return (
    <Item
      className={cn(interactive && "group")}
      render={render}
      title={props.tooltip}
    >
      <ItemMedia>{props.icon}</ItemMedia>
      <ItemContent>
        <span className="flex min-w-0 items-start gap-2.5">
          <span className="flex min-w-0 flex-1 items-center text-sm font-medium leading-5 text-dashboard-text">
            <span className="truncate">{props.title}</span>
            {props.href ? <OutboundIcon /> : null}
          </span>
          <span className="shrink-0 text-xs leading-5 tabular-nums text-dashboard-text-muted">
            {props.meta}
          </span>
        </span>
        {props.children}
      </ItemContent>
    </Item>
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
        "min-w-0 text-xs leading-4 text-dashboard-text-muted",
        props.className,
      )}
    >
      {props.children}
    </div>
  );
}
