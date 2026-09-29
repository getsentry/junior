import type { ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router";

import { pathWithSearch } from "../../searchParams";
import { SegmentedNav, type SegmentedNavItem } from "../SegmentedNav";
import {
  cn,
  dashboardContainerClass,
  dashboardInteractiveTextClass,
} from "../../styles";
import { SecondaryNavigationPortal } from "./DashboardChrome";

export type SecondaryNavigationItem = SegmentedNavItem;

type LinkClassState = { isActive: boolean };

function DrawerNavItem(props: {
  className: (state: LinkClassState) => string;
  item: SecondaryNavigationItem;
  pathname: string;
  search: string;
}) {
  const { className, item, pathname, search } = props;
  // Keep page filters (range, scope, q) when moving across secondary sections.
  const to = pathWithSearch(item.to, search);
  if (item.isActive) {
    const isActive = item.isActive(pathname);
    return (
      <Link
        aria-current={isActive ? "page" : undefined}
        className={className({ isActive })}
        to={to}
      >
        {item.label}
      </Link>
    );
  }

  return (
    <NavLink className={className} end={item.end} to={to}>
      {item.label}
    </NavLink>
  );
}

/**
 * Render page navigation in the desktop chrome, mobile page, and mobile drawer.
 * Desktop and mobile pages both use `SegmentedNav`, so each breakpoint shows
 * the same links the same way. Pass the page as children. The mobile tabs and
 * the page then share one shell grid row, so the tabs cannot take the row that
 * fills the screen.
 */
export function SecondaryNavigation(props: {
  ariaLabel: string;
  children: ReactNode;
  items: SecondaryNavigationItem[];
}) {
  const location = useLocation();
  const drawerLinkClass = ({ isActive }: LinkClassState) =>
    cn(
      "rounded-lg px-3 py-3 pl-6 font-mono text-sm font-medium no-underline transition-colors",
      isActive
        ? "bg-cyan-300/[0.1] text-cyan-50"
        : cn("hover:bg-white/[0.035]", dashboardInteractiveTextClass),
    );

  return (
    <div className="min-w-0">
      <SecondaryNavigationPortal
        desktop={
          <div className="border-b border-white/[0.06] bg-white/[0.018]">
            <div
              className={cn(
                dashboardContainerClass,
                "min-w-0 px-4 py-2 md:px-8",
              )}
            >
              <SegmentedNav
                ariaLabel={props.ariaLabel}
                items={props.items}
                pathname={location.pathname}
                search={location.search}
              />
            </div>
          </div>
        }
        mobilePage={
          <div className="min-w-0 px-4 pt-4 sm:px-8 md:hidden">
            <SegmentedNav
              ariaLabel={props.ariaLabel}
              fill
              items={props.items}
              pathname={location.pathname}
              search={location.search}
            />
          </div>
        }
        mobile={
          <nav
            aria-label={props.ariaLabel}
            className="mt-3 grid gap-1 border-t border-white/[0.07] pt-3"
          >
            {props.items.map((item) => (
              <DrawerNavItem
                className={drawerLinkClass}
                item={item}
                key={item.to}
                pathname={location.pathname}
                search={location.search}
              />
            ))}
          </nav>
        }
      />
      {props.children}
    </div>
  );
}
