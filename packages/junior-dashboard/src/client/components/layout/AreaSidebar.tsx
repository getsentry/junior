import { ArrowLeft, ChevronRight } from "lucide-react";
import { Link, useLocation } from "react-router";

import { cn } from "../../styles";
import { useCurrentAnchor } from "./AnchorHeading";
import { usePaneBackToTab } from "./PaneNav";

/** One page in an area, such as "Users" in System, or a section of one. */
type AreaItem = {
  /** The section's heading id, when the item is a section of one page. */
  anchor?: string;
  /** Match only this exact path, as for an area's first page. */
  end?: boolean;
  /** A second line, such as a repository's provider. */
  detail?: string;
  isActive?(pathname: string): boolean;
  label: string;
  to: string;
};

/**
 * A part of the dashboard outside the tabs, such as Settings or System.
 * Its pages list in the pane, like Android settings, so the pane is never
 * empty. The main pane shows the page that is picked.
 */
export type Area = {
  items: AreaItem[];
  label: string;
  /** The area's first page. On phones it shows the list instead. */
  root: string;
};

/**
 * True when the items are separate pages. An area whose items are sections
 * of one page shows that page on phones, since the page is the list.
 */
export function areaListsPages(area: Area): boolean {
  return !area.items.some((item) => item.anchor);
}

/** On phones the root shows the list, so its own page opens with this. */
export const AREA_PAGE_PARAM = "page";

function itemActive(item: AreaItem, pathname: string): boolean {
  if (item.isActive) return item.isActive(pathname);
  if (item.end) return pathname === item.to;
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}

/** Where a list row goes. On phones the root row opens its page. */
function areaItemHref(area: Area, item: AreaItem, phone: boolean) {
  return phone && item.to === area.root
    ? `${item.to}?${AREA_PAGE_PARAM}=1`
    : item.to;
}

/**
 * List an area's pages in the pane, under the way back to the tab the
 * reader came from. On phones the same list is the area's first screen.
 */
export function AreaSidebar(props: { area: Area; phone?: boolean }) {
  const { pathname } = useLocation();
  const back = usePaneBackToTab();
  const { area } = props;
  // Sections mark the one in view; pages mark the one that shows.
  const currentAnchor = useCurrentAnchor(
    area.items.flatMap((item) => (item.anchor ? [item.anchor] : [])),
  );
  return (
    <nav
      aria-label={area.label}
      className={cn(
        "grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] bg-dashboard-surface-panel",
        !props.phone && "border-r border-dashboard-border",
      )}
    >
      <div className="grid gap-1 px-3.5 pt-3 pb-2">
        <Link
          className="inline-flex w-fit items-center gap-1 rounded font-sans text-xs font-medium text-dashboard-text-muted no-underline transition-colors hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-dashboard-focus"
          to={back.to}
        >
          <ArrowLeft aria-hidden="true" size={13} />
          {back.label}
        </Link>
        <h2 className="m-0 font-display text-lg font-medium leading-tight tracking-tight text-dashboard-text">
          {area.label}
        </h2>
      </div>
      <ul className="thin-scrollbar m-0 grid min-h-0 content-start gap-0.5 overflow-y-auto px-1.5 pb-4">
        {area.items.map((item) => {
          // On phones the list is its own screen, so nothing is picked.
          const active =
            !props.phone &&
            (item.anchor
              ? item.anchor === currentAnchor
              : itemActive(item, pathname));
          return (
            <li className="list-none" key={item.to}>
              <Link
                aria-current={
                  active ? (item.anchor ? "location" : "page") : undefined
                }
                className={cn(
                  "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 rounded-lg px-2 font-sans no-underline transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus",
                  props.phone ? "py-3" : "py-2 comfortable:py-2.5",
                  active
                    ? "bg-dashboard-accent/[0.12] text-dashboard-accent-text"
                    : "text-dashboard-text hover:bg-dashboard-fill-hover",
                )}
                to={areaItemHref(area, item, Boolean(props.phone))}
              >
                <span className="grid min-w-0 gap-0.5">
                  <span
                    className={cn(
                      "truncate text-sm",
                      active ? "font-semibold" : "font-medium",
                    )}
                  >
                    {item.label}
                  </span>
                  {item.detail ? (
                    <span className="truncate text-xs text-dashboard-text-muted">
                      {item.detail}
                    </span>
                  ) : null}
                </span>
                {props.phone ? (
                  <ChevronRight
                    aria-hidden="true"
                    className="text-dashboard-text-faint"
                    size={16}
                  />
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
