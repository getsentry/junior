import { ChevronRight, Ellipsis } from "lucide-react";
import { useState, type ReactElement, type ReactNode } from "react";
import { Link } from "react-router";

import { SectionTitle } from "../components/layout/SectionTitle";
import { Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Item, ItemContent, ItemMedia } from "../components/ui/item";
import {
  cn,
  dashboardCountClass,
  dashboardDisclosureChevronClass,
} from "../styles";
import { OutboundIcon } from "../components/OutboundLink";

/**
 * Group one kind of detail in a compact card, such as in event details. A
 * `label` names the card as a region. Cards are flat sections, so a details
 * panel has no nested frames.
 */
export function DetailsCard(props: {
  children: ReactNode;
  count?: number | undefined;
  label?: string | undefined;
  title?: string | undefined;
}) {
  return (
    <section
      aria-label={props.label}
      className="grid min-w-0 gap-1.5 border-t border-dashboard-border-subtle px-1 pt-3 pb-1"
    >
      {props.title ? (
        <h3 className="m-0 flex min-w-0 items-center gap-1.5 break-words font-sans text-xs font-semibold text-dashboard-text">
          {props.title}
          {props.count ? (
            <span className={cn("font-normal", dashboardCountClass)}>
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

/**
 * Title one section of Conversation details with its rows, and an optional
 * "Show finished" disclosure for rows that are done. The section hides when
 * it has no rows at all.
 */
export function DetailsSection(props: {
  /** Rows that stay hidden until the reader asks for them. */
  finished?: readonly ReactElement[];
  /** Keyed rows. The key stays with a row when it moves to finished. */
  rows: readonly ReactElement[];
  title: string;
}) {
  const [showFinished, setShowFinished] = useState(false);
  const finished = props.finished ?? [];
  if (props.rows.length === 0 && finished.length === 0) return null;
  return (
    <section aria-label={props.title} className="grid min-w-0 gap-2">
      <SectionTitle>{props.title}</SectionTitle>
      {/* Rows own their padding, so the hover fill keeps an even inset. The
          negative margin keeps row text on the panel padding. */}
      <ul className="-mx-1.5 my-0 grid list-none p-0">
        {props.rows.map((row) => (
          <li key={row.key}>{row}</li>
        ))}
        {showFinished
          ? finished.map((row) => <li key={row.key}>{row}</li>)
          : null}
        {finished.length > 0 ? (
          <li>
            <Button
              aria-expanded={showFinished}
              className="group flex min-h-8 w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left text-xs leading-5 text-dashboard-text-muted focus-visible:-outline-offset-2"
              onClick={() => setShowFinished((value) => !value)}
              size="bare"
              variant="ghost"
            >
              <span className="grid size-5 shrink-0 place-items-center">
                <ChevronRight
                  aria-hidden="true"
                  className={dashboardDisclosureChevronClass}
                />
              </span>
              {showFinished ? "Hide finished" : "Show finished"}
            </Button>
          </li>
        ) : null}
      </ul>
    </section>
  );
}

/**
 * Lay out one details row: a 16px icon, a title that wraps, and optional
 * muted lines under it. A row with `href` opens that link in a new tab, a
 * row with `to` opens a dashboard page, and an `onClick` row is a button.
 * `menu` shows at the end of the row on hover or focus.
 */
export function DetailsRow(props: {
  children?: ReactNode;
  href?: string | undefined;
  icon: ReactNode;
  /** Row actions, such as a menu. They show on hover or focus. */
  menu?: ReactNode;
  onClick?(): void;
  title: ReactNode;
  to?: string | undefined;
  /** Native hover text with detail that the row does not show. */
  tooltip?: string | undefined;
}) {
  const interactive =
    props.href !== undefined ||
    props.to !== undefined ||
    props.onClick !== undefined;
  const hasMenu = Boolean(props.menu);
  const render = props.href ? (
    <a href={props.href} rel="noreferrer" target="_blank" />
  ) : props.to ? (
    <Link to={props.to} />
  ) : props.onClick ? (
    <button onClick={props.onClick} type="button" />
  ) : undefined;
  const row = (
    <Item
      // A touch screen always shows the menu, so the title stops before it.
      className={cn(
        interactive && "group",
        hasMenu && "[@media(hover:none)]:pe-8",
      )}
      render={render}
      title={props.tooltip}
    >
      <ItemMedia>{props.icon}</ItemMedia>
      <ItemContent>
        <span className="min-w-0 break-words text-sm font-medium leading-5 text-dashboard-text">
          {props.title}
          {props.href ? <OutboundIcon /> : null}
        </span>
        {props.children}
      </ItemContent>
    </Item>
  );
  if (!hasMenu) return row;
  return (
    <div className="group/row relative min-w-0">
      {row}
      {/* Over the row's end, so the row keeps its full width on hover. */}
      <div className="absolute top-1 right-1 opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 has-[[aria-expanded=true]]:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100">
        {props.menu}
      </div>
    </div>
  );
}

/** Place one muted line under the title of a `DetailsRow`, up to two lines. */
export function DetailsRowLine(props: { children: ReactNode }) {
  return (
    <div className="line-clamp-2 min-w-0 break-words text-xs leading-4 text-dashboard-text-muted">
      {props.children}
    </div>
  );
}

/** The menu of one `DetailsRow`: one trigger that shows on hover or focus. */
export function DetailsRowMenu(props: {
  children: ReactNode;
  disabled?: boolean;
  label: string;
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        aria-label={props.label}
        className="grid size-6 place-items-center rounded-md bg-dashboard-surface-panel text-dashboard-text-muted transition-colors hover:bg-dashboard-surface-hover hover:text-dashboard-text focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus"
        disabled={props.disabled}
      >
        <Ellipsis aria-hidden="true" size={15} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36 max-w-72">
        {props.children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
