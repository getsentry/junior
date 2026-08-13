import { NavLink } from "react-router";

import {
  cn,
  dashboardContainerClass,
  dashboardInteractiveTextClass,
} from "../../styles";
import { SecondaryNavigationPortal } from "./DashboardChrome";

export type SecondaryNavigationItem = {
  end?: boolean;
  label: string;
  to: string;
};

/** Render page navigation in the desktop chrome and mobile drawer. */
export function SecondaryNavigation(props: {
  ariaLabel: string;
  items: SecondaryNavigationItem[];
}) {
  const desktopLinkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      "relative flex h-12 shrink-0 items-center px-3 font-display text-xs font-medium no-underline transition-colors after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:transition-colors sm:text-sm",
      isActive
        ? "text-dashboard-text after:bg-cyan-300"
        : cn(
            "after:bg-transparent hover:bg-dashboard-fill-soft",
            dashboardInteractiveTextClass,
          ),
    );
  const mobileLinkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      "rounded-md px-2.5 py-2 pl-5 font-mono text-xs font-medium no-underline transition-colors",
      isActive
        ? "bg-cyan-300/[0.1] text-cyan-50"
        : cn("hover:bg-dashboard-fill-muted", dashboardInteractiveTextClass),
    );

  return (
    <SecondaryNavigationPortal
      desktop={
        <div className="border-b border-dashboard-border-subtle bg-dashboard-fill-quiet">
          <nav
            aria-label={props.ariaLabel}
            className={cn(
              dashboardContainerClass,
              "flex min-w-0 gap-1 overflow-x-auto px-4 [scrollbar-width:none] md:px-8 [&::-webkit-scrollbar]:hidden",
            )}
          >
            {props.items.map((item) => (
              <NavLink
                className={desktopLinkClass}
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
          className="mt-2 grid gap-1 border-t border-dashboard-border pt-2"
        >
          {props.items.map((item) => (
            <NavLink
              className={mobileLinkClass}
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
