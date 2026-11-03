import {
  Boxes,
  Brain,
  CodeXml,
  Gauge,
  Inbox,
  MessagesSquare,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { Link, NavLink } from "react-router";

import { getDashboardAgentName } from "../../agentName";
import { JuniorLogo } from "../JuniorLogo";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { cn, dashboardInteractiveTextClass } from "../../styles";
import type { DashboardHeaderNavItem } from "./DashboardHeader";

/** Left padding that keeps desktop page content clear of the fixed rail. */
export const navRailOffsetClass = "md:pl-14";

// Plugin primary pages without an entry here use the generic plugin icon.
const NAV_ICONS: Record<string, LucideIcon> = {
  automations: Zap,
  code: CodeXml,
  "memory:memories": Brain,
  review: Inbox,
  system: Gauge,
};

function RailIcon(props: {
  active: boolean;
  count?: number;
  icon: LucideIcon;
}) {
  const Icon = props.icon;
  return (
    <span
      className={cn(
        "relative grid size-10 place-items-center rounded-lg transition-colors group-focus-visible:outline group-focus-visible:outline-2 group-focus-visible:outline-dashboard-focus/70",
        props.active
          ? "bg-dashboard-accent/[0.12] text-dashboard-accent-text"
          : cn(
              "group-hover:bg-dashboard-fill-soft",
              dashboardInteractiveTextClass,
            ),
      )}
    >
      <Icon aria-hidden="true" size={19} strokeWidth={1.9} />
      {props.count ? (
        <span
          aria-hidden="true"
          className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-dashboard-accent px-1 text-2xs font-semibold leading-none text-dashboard-text-inverse tabular-nums ring-2 ring-dashboard-bg"
        >
          {props.count > 99 ? "99+" : props.count.toLocaleString("en-US")}
        </span>
      ) : null}
    </span>
  );
}

function RailTooltip(props: { children: ReactElement; label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={props.children} />
      <TooltipContent side="right" size="compact" sideOffset={6}>
        {props.label}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Desktop primary navigation as a fixed icon rail. Mobile keeps the top bar
 * and navigation sheet in `DashboardHeader`.
 */
export function NavRail(props: {
  navItems: DashboardHeaderNavItem[];
  profile?: ReactNode;
  workspaceActive: boolean;
}) {
  const linkClass =
    "group flex w-full justify-center text-inherit no-underline focus-visible:outline-none";

  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-14 flex-col items-center border-r border-dashboard-border-strong bg-dashboard-bg pt-[env(safe-area-inset-top)] md:flex">
      <Link
        aria-label={`${getDashboardAgentName()} home`}
        className="mb-4 mt-3 grid place-items-center text-inherit no-underline"
        to="/"
      >
        <JuniorLogo />
      </Link>
      <nav
        aria-label="Primary"
        className="flex min-h-0 w-full flex-1 flex-col items-center gap-1.5 overflow-y-auto"
      >
        <RailTooltip label="Conversations">
          <Link
            aria-current={props.workspaceActive ? "page" : undefined}
            aria-label="Conversations"
            className={linkClass}
            to="/"
          >
            <RailIcon active={props.workspaceActive} icon={MessagesSquare} />
          </Link>
        </RailTooltip>
        {props.navItems.map((item) => {
          const label = item.count
            ? `${item.label} ${item.count.toLocaleString("en-US")}`
            : item.label;
          return (
            <RailTooltip key={item.key} label={label}>
              <NavLink aria-label={label} className={linkClass} to={item.to}>
                {({ isActive }) => (
                  <RailIcon
                    active={isActive}
                    count={item.count}
                    icon={NAV_ICONS[item.key] ?? Boxes}
                  />
                )}
              </NavLink>
            </RailTooltip>
          );
        })}
      </nav>
      {props.profile ? (
        <div className="mb-3 mt-2 grid place-items-center">{props.profile}</div>
      ) : null}
    </aside>
  );
}
