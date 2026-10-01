import type { ReactNode } from "react";

import {
  SegmentedNav,
  SiblingPageLink,
  type SegmentedNavItem,
} from "../SegmentedNav";
import {
  cn,
  dashboardContainerClass,
  dashboardInteractiveTextClass,
} from "../../styles";
import { SecondaryNavigationPortal } from "./DashboardChrome";

export type SecondaryNavigationItem = SegmentedNavItem;

/**
 * Render page navigation above the page, in the desktop chrome, and in the
 * mobile menu. On mobile the links sit at the top of the page and scroll with
 * it. Pass the page as children so the links and the page share one layout
 * row.
 */
export function SecondaryNavigation(props: {
  ariaLabel: string;
  children: ReactNode;
  items: SecondaryNavigationItem[];
}) {
  const menuLinkClass = ({ isActive }: { isActive: boolean }) =>
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
              <SegmentedNav ariaLabel={props.ariaLabel} items={props.items} />
            </div>
          </div>
        }
        mobile={
          <nav
            aria-label={props.ariaLabel}
            className="mt-3 grid gap-1 border-t border-white/[0.07] pt-3"
          >
            {props.items.map((item) => (
              <SiblingPageLink
                className={menuLinkClass}
                item={item}
                key={item.to}
              />
            ))}
          </nav>
        }
      />
      <div className="px-4 pt-4 sm:px-8 md:hidden">
        <SegmentedNav ariaLabel={props.ariaLabel} fill items={props.items} />
      </div>
      {props.children}
    </div>
  );
}
