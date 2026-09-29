import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router";

import { pathWithSearch } from "../../searchParams";
import { segmentedTabClass, segmentedTabsTrackClass } from "../SegmentedTabs";
import {
  cn,
  dashboardContainerClass,
  dashboardInteractiveTextClass,
} from "../../styles";
import { SecondaryNavigationPortal } from "./DashboardChrome";

export type SecondaryNavigationItem = {
  end?: boolean;
  /** Override default NavLink matching when a path family should stay active. */
  isActive?: (pathname: string) => boolean;
  label: string;
  to: string;
};

type LinkClassState = { isActive: boolean };

function SecondaryNavItem(props: {
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

/** Keep the current page link visible in a horizontally scrolled nav. */
function useScrollCurrentLinkIntoView(pathname: string) {
  const navRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const nav = navRef.current;
    const link = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !link) return;
    const start = link.offsetLeft;
    const end = start + link.offsetWidth;
    if (start >= nav.scrollLeft && end <= nav.scrollLeft + nav.clientWidth) {
      return;
    }
    // Set scrollLeft directly. scrollIntoView can also scroll the page.
    nav.scrollLeft = start - (nav.clientWidth - link.offsetWidth) / 2;
  }, [pathname]);
  return navRef;
}

/**
 * Render page navigation in the desktop chrome, mobile page, and mobile drawer.
 * Pass the page as children. The mobile tabs and the page then share one shell
 * grid row, so the tabs cannot take the row that fills the screen.
 */
export function SecondaryNavigation(props: {
  ariaLabel: string;
  children: ReactNode;
  items: SecondaryNavigationItem[];
}) {
  const location = useLocation();
  const mobilePageNavRef = useScrollCurrentLinkIntoView(location.pathname);
  const desktopLinkClass = ({ isActive }: LinkClassState) =>
    cn(
      "relative flex h-12 shrink-0 items-center px-3 font-display text-xs font-medium no-underline transition-colors after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:transition-colors sm:text-sm",
      isActive
        ? "text-dashboard-text after:bg-cyan-300"
        : cn(
            "after:bg-transparent hover:bg-white/[0.025]",
            dashboardInteractiveTextClass,
          ),
    );
  // Segmented tabs share space equally. With many pages, each tab keeps its
  // label width and the row scrolls sideways.
  const mobilePageLinkClass = ({ isActive }: LinkClassState) =>
    cn(
      segmentedTabClass(isActive),
      "flex flex-1 items-center justify-center whitespace-nowrap no-underline",
    );
  const mobileLinkClass = ({ isActive }: LinkClassState) =>
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
            <nav
              aria-label={props.ariaLabel}
              className={cn(
                dashboardContainerClass,
                "flex min-w-0 gap-1 overflow-x-auto px-4 [scrollbar-width:none] md:px-8 [&::-webkit-scrollbar]:hidden",
              )}
            >
              {props.items.map((item) => (
                <SecondaryNavItem
                  className={desktopLinkClass}
                  item={item}
                  key={item.to}
                  pathname={location.pathname}
                  search={location.search}
                />
              ))}
            </nav>
          </div>
        }
        mobilePage={
          <div className="min-w-0 px-4 pt-4 sm:px-8 md:hidden">
            <nav
              aria-label={props.ariaLabel}
              className={cn(
                segmentedTabsTrackClass,
                "relative flex overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
              )}
              ref={mobilePageNavRef}
            >
              {props.items.map((item) => (
                <SecondaryNavItem
                  className={mobilePageLinkClass}
                  item={item}
                  key={item.to}
                  pathname={location.pathname}
                  search={location.search}
                />
              ))}
            </nav>
          </div>
        }
        mobile={
          <nav
            aria-label={props.ariaLabel}
            className="mt-3 grid gap-1 border-t border-white/[0.07] pt-3"
          >
            {props.items.map((item) => (
              <SecondaryNavItem
                className={mobileLinkClass}
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
