import { Link, NavLink, useLocation } from "react-router";

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
}) {
  const { className, item, pathname } = props;
  if (item.isActive) {
    const isActive = item.isActive(pathname);
    return (
      <Link
        aria-current={isActive ? "page" : undefined}
        className={className({ isActive })}
        to={item.to}
      >
        {item.label}
      </Link>
    );
  }

  return (
    <NavLink className={className} end={item.end} to={item.to}>
      {item.label}
    </NavLink>
  );
}

/** Render page navigation in the desktop chrome and mobile drawer. */
export function SecondaryNavigation(props: {
  ariaLabel: string;
  items: SecondaryNavigationItem[];
}) {
  const location = useLocation();
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
  const mobileLinkClass = ({ isActive }: LinkClassState) =>
    cn(
      "rounded-lg px-3 py-3 pl-6 font-mono text-sm font-medium no-underline transition-colors",
      isActive
        ? "bg-cyan-300/[0.1] text-cyan-50"
        : cn("hover:bg-white/[0.035]", dashboardInteractiveTextClass),
    );

  return (
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
            />
          ))}
        </nav>
      }
    />
  );
}
