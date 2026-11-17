import { createContext, useContext, type ReactNode } from "react";

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
 * The new UI's pane state: whether the desktop pane shows, and Zen mode.
 * `PaneNav` provides it. The current UI has none.
 */
export const PaneLinksContext = createContext<{
  paneOpen: boolean;
  zen: boolean;
} | null>(null);

/**
 * Render page navigation above the page, in the desktop chrome, and in the
 * mobile menu. On mobile the links sit at the top of the page and scroll with
 * it. Pass the page as children so the links and the page share one layout
 * row.
 */
export function SecondaryNavigation(props: {
  ariaLabel: string;
  className?: string | undefined;
  children: ReactNode;
  items: SecondaryNavigationItem[];
  /**
   * In the new UI, the pane lists these pages (see `AreaSidebar`), so the
   * desktop links show only while the reader has closed the pane, not in
   * Zen mode, and phones open on the list instead.
   */
  listedInPane?: boolean;
  /**
   * Phones open the area on this page, not on the list, so they keep the
   * page links. Memories does: its Overview is a page of sections.
   */
  opensOnPhone?: boolean;
}) {
  const pane = useContext(PaneLinksContext);
  const listed = pane !== null && props.listedInPane === true;
  // Zen mode hides the pane too, but it hides the page links with it.
  const desktopLinks = !listed || (!pane?.paneOpen && !pane?.zen);
  const menuLinkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      "rounded-lg px-3 py-3 pl-6 font-sans text-sm font-medium no-underline transition-colors",
      isActive
        ? "bg-dashboard-accent/[0.1] text-dashboard-accent-text"
        : cn("hover:bg-dashboard-fill-faint", dashboardInteractiveTextClass),
    );

  return (
    <div className={cn("min-w-0", props.className)}>
      <SecondaryNavigationPortal
        desktop={
          desktopLinks ? (
            <div
              className={cn(dashboardContainerClass, "min-w-0 px-4 md:px-8")}
            >
              <SegmentedNav
                ariaLabel={props.ariaLabel}
                items={props.items}
                toolbar={pane !== null}
              />
            </div>
          ) : null
        }
        mobile={
          <nav
            aria-label={props.ariaLabel}
            className="mt-3 grid gap-1 border-t border-dashboard-border pt-3"
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
      {listed && !props.opensOnPhone ? null : (
        <div className="border-b border-dashboard-border px-4 pt-2 sm:px-8 md:hidden">
          <SegmentedNav ariaLabel={props.ariaLabel} fill items={props.items} />
        </div>
      )}
      {props.children}
    </div>
  );
}
