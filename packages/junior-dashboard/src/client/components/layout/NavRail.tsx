import {
  ChevronsLeft,
  ChevronsRight,
  MessagesSquare,
  Search,
  type LucideIcon,
} from "lucide-react";
import { useLocalStorage } from "@uidotdev/usehooks";
import { useEffect, type CSSProperties, type ReactNode } from "react";
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
  useSidebar,
} from "../ui/sidebar";
import type { DashboardHeaderNavItem } from "./DashboardHeader";
import { navItemIcon } from "./navIcons";
import { Separator } from "../ui/separator";
import {
  COMMAND_PALETTE_LABEL,
  COMMAND_PALETTE_SHORTCUT,
} from "../CommandPalette";
import { isPlatformShortcut } from "../../keyboard";
import { cn } from "../../styles";

const OPEN_KEY = "junior:nav:sidebar-open";

const RAIL_BUTTON_CLASS =
  "h-10 gap-3 rounded-lg px-2.5 text-dashboard-text-muted group-data-[collapsible=icon]:size-10! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0! data-active:bg-dashboard-accent/[0.12] data-active:font-normal data-active:text-dashboard-accent-text [&_svg]:size-5";

const RAIL_LABEL_CLASS = "group-data-[collapsible=icon]:hidden";

// 208px sidebar, or a 56px rail with 40px targets.
const RAIL_STYLE = {
  "--sidebar-width": "13rem",
  "--sidebar-width-icon": "3.5rem",
} as CSSProperties;

/**
 * Lay out the desktop nav sidebar beside the page. It starts as the icon rail
 * until the viewer expands it, and keeps that choice for this browser.
 */
export function NavRailProvider(props: { children: ReactNode }) {
  const [open, setOpen] = useLocalStorage(OPEN_KEY, false);
  return (
    <SidebarProvider onOpenChange={setOpen} open={open} style={RAIL_STYLE}>
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
        className={RAIL_BUTTON_CLASS}
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
        <span className={RAIL_LABEL_CLASS}>{props.label}</span>
      </SidebarMenuButton>
      {props.count ? (
        <SidebarMenuBadge
          aria-hidden="true"
          className="top-1/2 right-2 h-4 min-w-4 -translate-y-1/2 rounded-full bg-dashboard-accent px-1 text-2xs font-semibold leading-none normal-nums text-dashboard-text-inverse peer-data-[size=default]/menu-button:top-1/2 peer-data-active/menu-button:text-dashboard-text-inverse peer-hover/menu-button:text-dashboard-text-inverse group-data-[collapsible=icon]:top-0! group-data-[collapsible=icon]:right-0 group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:translate-y-0 group-data-[collapsible=icon]:ring-2 group-data-[collapsible=icon]:ring-sidebar"
        >
          {props.count > 99 ? "99+" : props.count.toLocaleString("en-US")}
        </SidebarMenuBadge>
      ) : null}
    </SidebarMenuItem>
  );
}

function RailSearchItem(props: { onSearch(): void }) {
  return (
    <SidebarMenu className="mt-3 group-data-[collapsible=icon]:items-center">
      <SidebarMenuItem>
        <SidebarMenuButton
          aria-keyshortcuts="Meta+K Control+K"
          aria-label={COMMAND_PALETTE_LABEL}
          className={RAIL_BUTTON_CLASS}
          onClick={props.onSearch}
          tooltip={{
            children: `${COMMAND_PALETTE_LABEL} ${COMMAND_PALETTE_SHORTCUT}`,
            size: "compact",
            sideOffset: 6,
          }}
        >
          <Search aria-hidden="true" strokeWidth={1.9} />
          {/* The label fills the row, so the shortcut shows only in the
              collapsed tooltip. */}
          <span className={RAIL_LABEL_CLASS}>{COMMAND_PALETTE_LABEL}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function RailNavItem(props: { item: DashboardHeaderNavItem }) {
  const active = useMatch({ end: false, path: props.item.to }) !== null;
  return (
    <RailItem
      active={active}
      count={props.item.count}
      icon={navItemIcon(props.item.key)}
      label={props.item.label}
      to={props.item.to}
    />
  );
}

function RailToggle() {
  const { open, toggleSidebar } = useSidebar();
  // Bound here so the shortcut works only while the sidebar shows.
  useEffect(() => {
    const toggle = (event: KeyboardEvent) => {
      if (!isPlatformShortcut(event, "b") || event.repeat) return;
      event.preventDefault();
      toggleSidebar();
    };
    window.addEventListener("keydown", toggle);
    return () => window.removeEventListener("keydown", toggle);
  }, [toggleSidebar]);
  const label = open ? "Collapse sidebar" : "Expand sidebar";
  const Icon = open ? ChevronsLeft : ChevronsRight;
  return (
    <SidebarMenuButton
      aria-expanded={open}
      aria-keyshortcuts="Meta+B Control+B"
      aria-label={label}
      className="size-8! justify-center rounded-lg p-0! text-dashboard-text-faint hover:text-dashboard-text [&_svg]:size-4"
      onClick={toggleSidebar}
      tooltip={{ children: label, size: "compact", sideOffset: 6 }}
    >
      <Icon aria-hidden="true" strokeWidth={2} />
    </SidebarMenuButton>
  );
}

/**
 * Desktop primary navigation when the top bar is off: the icon rail, or icons
 * and labels when expanded. `DashboardHeader` owns the top bar and mobile
 * navigation.
 */
export function NavRail(props: {
  navItems: DashboardHeaderNavItem[];
  onSearch(): void;
  profile?: ReactNode;
  workspaceActive: boolean;
}) {
  return (
    <Sidebar
      className="border-dashboard-border-strong pt-[env(safe-area-inset-top)]"
      collapsible="icon"
    >
      <SidebarHeader className="px-3 pt-3 pb-4 group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:px-2">
        <div className="flex items-center justify-between gap-2 group-data-[collapsible=icon]:flex-col">
          <Link
            aria-label={`${getDashboardAgentName()} home`}
            className="flex min-w-0 items-center gap-2 text-inherit no-underline"
            to="/"
          >
            <JuniorLogo />
            <span
              className={cn(
                "truncate font-sans text-sm font-semibold",
                RAIL_LABEL_CLASS,
              )}
            >
              {getDashboardAgentName()}
            </span>
          </Link>
          <RailToggle />
        </div>
        <RailSearchItem onSearch={props.onSearch} />
        {/* Splits the global search from the page links below. */}
        <Separator className="mt-1 bg-dashboard-border-strong group-data-[collapsible=icon]:data-horizontal:w-6" />
      </SidebarHeader>
      {/* Stock icon mode hides overflow; let plugin pages scroll on short
        windows in both widths. */}
      <SidebarContent className="group-data-[collapsible=icon]:overflow-auto">
        <SidebarGroup className="px-3 py-0 group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:px-2">
          <nav aria-label="Primary" className="w-full">
            <SidebarMenu className="gap-1 group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:gap-1.5">
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
        <SidebarFooter className="px-3 pb-3 group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:px-2">
          <SidebarMenu className="group-data-[collapsible=icon]:items-center">
            {props.profile}
          </SidebarMenu>
        </SidebarFooter>
      ) : null}
    </Sidebar>
  );
}
