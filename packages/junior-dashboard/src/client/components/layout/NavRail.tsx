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
import type { CSSProperties, ReactNode } from "react";
import { Link, useMatch } from "react-router";

import { getDashboardAgentName } from "../../agentName";
import { JuniorLogo } from "../JuniorLogo";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "../ui/sidebar";
import type { DashboardHeaderNavItem } from "./DashboardHeader";

// Plugin primary pages without an entry here use the generic plugin icon.
const NAV_ICONS: Record<string, LucideIcon> = {
  automations: Zap,
  code: CodeXml,
  "memory:memories": Brain,
  review: Inbox,
  system: Gauge,
};

// 56px rail with 40px targets, so the icons keep their size from the top bar.
const RAIL_STYLE = { "--sidebar-width-icon": "3.5rem" } as CSSProperties;

/**
 * Lay out the desktop nav rail beside the page. The rail is always the
 * collapsed (icon) shadcn sidebar, and the provider's spacer keeps page
 * content clear of it.
 */
export function NavRailProvider(props: { children: ReactNode }) {
  return (
    <SidebarProvider open={false} style={RAIL_STYLE}>
      {props.children}
    </SidebarProvider>
  );
}

function RailItem(props: {
  active: boolean;
  count?: number;
  icon: LucideIcon;
  label: string;
  to: string;
}) {
  const Icon = props.icon;
  const label = props.count
    ? `${props.label} ${props.count.toLocaleString("en-US")}`
    : props.label;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        aria-label={label}
        className="justify-center rounded-lg text-dashboard-text-muted group-data-[collapsible=icon]:size-10! group-data-[collapsible=icon]:p-0! data-active:bg-dashboard-accent/[0.12] data-active:font-normal data-active:text-dashboard-accent-text [&_svg]:size-5"
        isActive={props.active}
        render={
          <Link
            aria-current={props.active ? "page" : undefined}
            to={props.to}
          />
        }
        tooltip={{ children: label, size: "compact", sideOffset: 6 }}
      >
        <Icon aria-hidden="true" strokeWidth={1.9} />
      </SidebarMenuButton>
      {props.count ? (
        <SidebarMenuBadge
          aria-hidden="true"
          className="-top-2 -right-1.5 h-4 min-w-4 rounded-full bg-dashboard-accent px-1 text-2xs font-semibold leading-none normal-nums text-dashboard-text-inverse ring-2 ring-sidebar group-data-[collapsible=icon]:flex peer-data-[size=default]/menu-button:-top-2 peer-data-active/menu-button:text-dashboard-text-inverse peer-hover/menu-button:text-dashboard-text-inverse"
        >
          {props.count > 99 ? "99+" : props.count.toLocaleString("en-US")}
        </SidebarMenuBadge>
      ) : null}
    </SidebarMenuItem>
  );
}

function RailNavItem(props: { item: DashboardHeaderNavItem }) {
  const active = useMatch({ end: false, path: props.item.to }) !== null;
  return (
    <RailItem
      active={active}
      count={props.item.count}
      icon={NAV_ICONS[props.item.key] ?? Boxes}
      label={props.item.label}
      to={props.item.to}
    />
  );
}

/**
 * Desktop primary navigation as a shadcn icon sidebar. Mobile keeps the top
 * bar and navigation sheet in `DashboardHeader`.
 */
export function NavRail(props: {
  navItems: DashboardHeaderNavItem[];
  profile?: ReactNode;
  workspaceActive: boolean;
}) {
  return (
    <Sidebar
      className="border-dashboard-border-strong pt-[env(safe-area-inset-top)]"
      collapsible="icon"
    >
      <SidebarHeader className="items-center pt-3 pb-4">
        <Link
          aria-label={`${getDashboardAgentName()} home`}
          className="grid place-items-center text-inherit no-underline"
          to="/"
        >
          <JuniorLogo />
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="items-center py-0">
          <nav aria-label="Primary" className="w-full">
            <SidebarMenu className="items-center gap-1.5">
              <RailItem
                active={props.workspaceActive}
                icon={MessagesSquare}
                label="Conversations"
                to="/"
              />
              {props.navItems.map((item) => (
                <RailNavItem item={item} key={item.key} />
              ))}
            </SidebarMenu>
          </nav>
        </SidebarGroup>
      </SidebarContent>
      {props.profile ? (
        <SidebarFooter className="items-center pb-3">
          {props.profile}
        </SidebarFooter>
      ) : null}
    </Sidebar>
  );
}
