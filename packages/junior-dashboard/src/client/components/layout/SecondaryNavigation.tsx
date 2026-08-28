import { NavLink, useLocation } from "react-router";

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

function navigationLinkClass(
  baseClass: (state: { isActive: boolean }) => string,
  item: SecondaryNavigationItem,
  pathname: string,
) {
  return (state: { isActive: boolean }) =>
    baseClass({
      isActive: item.isActive ? item.isActive(pathname) : state.isActive,
    });
}

/** Render page navigation in the desktop chrome and mobile drawer. */
export function SecondaryNavigation(props: {
  ariaLabel: string;
  items: SecondaryNavigationItem[];
}) {
  const location = useLocation();
  const desktopLinkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      "relative flex h-12 shrink-0 items-center px-3 font-display text-xs font-medium no-underline transition-colors after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:transition-colors sm:text-sm",
      isActive
        ? "text-dashboard-text after:bg-cyan-300"
        : cn(
            "after:bg-transparent hover:bg-white/[0.025]",
            dashboardInteractiveTextClass,
          ),
    );
  const mobileLinkClass = ({ isActive }: { isActive: boolean }) =>
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
              <NavLink
                className={navigationLinkClass(
                  desktopLinkClass,
                  item,
                  location.pathname,
                )}
                end={item.end}
                key={item.to}
                to={item.to}
              >
                {item.label}
              </NavLink>
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
            <NavLink
              className={navigationLinkClass(
                mobileLinkClass,
                item,
                location.pathname,
              )}
              end={item.end}
              key={item.to}
              to={item.to}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      }
    />
  );
}
