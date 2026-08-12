import { Menu, X } from "lucide-react";
import type { ReactNode } from "react";
import { Link, NavLink } from "react-router";

import { getDashboardAgentName } from "../../agentName";
import { JuniorLogo } from "../JuniorLogo";
import {
  cn,
  dashboardContainerClass,
  dashboardInteractiveTextClass,
} from "../../styles";

export type DashboardHeaderNavItem = {
  key: string;
  label: string;
  to: string;
};

/** Render the primary dashboard shell header and optional mobile drawer. */
export function DashboardHeader(props: {
  compact?: boolean;
  mobileNavigationOpen: boolean;
  navItems: DashboardHeaderNavItem[];
  onMobileNavigationOpenChange(open: boolean): void;
  profile?: ReactNode;
  workspaceActive: boolean;
}) {
  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      "shrink-0 whitespace-nowrap rounded-md px-2.5 py-2 font-mono text-xs font-medium tracking-normal no-underline transition-colors",
      isActive
        ? "bg-cyan-300/[0.1] text-cyan-50"
        : cn("hover:bg-white/[0.035]", dashboardInteractiveTextClass),
    );

  return (
    <header className="relative border-b border-white/[0.05]">
      <div
        className={cn(
          dashboardContainerClass,
          "grid grid-cols-[2.5rem_minmax(0,1fr)_2.5rem] items-center gap-x-2 px-3 py-2 md:gap-x-5 md:gap-y-3 md:px-4 md:py-4",
          props.profile
            ? "md:grid-cols-[auto_minmax(0,1fr)_auto]"
            : "md:grid-cols-[auto_minmax(0,1fr)]",
          props.compact ? "md:px-4" : "md:px-8",
        )}
      >
        <button
          aria-controls="mobile-navigation"
          aria-expanded={props.mobileNavigationOpen}
          aria-label={`${props.mobileNavigationOpen ? "Close" : "Open"} navigation`}
          className="grid size-10 cursor-pointer place-items-center rounded-lg border-0 bg-transparent text-dashboard-text transition-colors hover:bg-white/[0.06] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#beaaff]/70 md:hidden"
          onClick={() =>
            props.onMobileNavigationOpenChange(!props.mobileNavigationOpen)
          }
          type="button"
        >
          {props.mobileNavigationOpen ? (
            <X aria-hidden="true" size={20} strokeWidth={2} />
          ) : (
            <Menu aria-hidden="true" size={20} strokeWidth={2} />
          )}
        </button>
        <Link
          aria-label={`${getDashboardAgentName()} home`}
          className="flex min-w-0 max-w-full items-center justify-self-center text-inherit no-underline md:justify-self-start"
          to="/"
        >
          <JuniorLogo />
        </Link>
        <nav
          aria-label="Primary"
          className="hidden min-w-0 items-center gap-1 md:col-start-2 md:flex md:justify-self-start"
        >
          <Link
            aria-current={props.workspaceActive ? "page" : undefined}
            className={navLinkClass({ isActive: props.workspaceActive })}
            to="/"
          >
            Conversations
          </Link>
          {props.navItems.map((item) => (
            <NavLink className={navLinkClass} key={item.key} to={item.to}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        {props.profile ? (
          <div className="col-start-3 justify-self-end">{props.profile}</div>
        ) : null}
      </div>
      {props.mobileNavigationOpen ? (
        <nav
          aria-label="Primary"
          className="absolute left-0 right-0 top-full grid gap-1 border-b border-white/[0.07] bg-dashboard-surface-raised/95 p-2 shadow-2xl shadow-black/60 backdrop-blur-xl md:hidden"
          id="mobile-navigation"
        >
          <Link
            aria-current={props.workspaceActive ? "page" : undefined}
            className={navLinkClass({ isActive: props.workspaceActive })}
            to="/"
          >
            Conversations
          </Link>
          {props.navItems.map((item) => (
            <NavLink className={navLinkClass} key={item.key} to={item.to}>
              {item.label}
            </NavLink>
          ))}
        </nav>
      ) : null}
    </header>
  );
}
