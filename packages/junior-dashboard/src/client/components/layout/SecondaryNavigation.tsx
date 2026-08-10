import { NavLink } from "react-router";

import {
  cn,
  dashboardContainerClass,
  dashboardInteractiveTextClass,
} from "../../styles";

export type SecondaryNavigationItem = {
  end?: boolean;
  label: string;
  to: string;
};

/** Render the shared page-level secondary navigation. */
export function SecondaryNavigation(props: {
  ariaLabel: string;
  items: SecondaryNavigationItem[];
}) {
  const linkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      "relative flex h-12 shrink-0 items-center px-3 font-display text-xs font-medium no-underline transition-colors after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:transition-colors sm:text-sm",
      isActive
        ? "text-dashboard-text after:bg-cyan-300"
        : cn(
            "after:bg-transparent hover:bg-white/[0.025]",
            dashboardInteractiveTextClass,
          ),
    );

  return (
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
            className={linkClass}
            end={item.end}
            key={item.to}
            to={item.to}
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
