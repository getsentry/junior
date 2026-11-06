import {
  ChevronsLeft,
  ChevronsRight,
  MessagesSquare,
  Search,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
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
import { navItemIcon } from "./navIcons";
import { Separator } from "../ui/separator";
import { COMMAND_PALETTE_SHORTCUT } from "../CommandPalette";
import { cn } from "../../styles";

const OPEN_KEY = "junior:nav:sidebar-open";
// From here the nav sidebar, conversation list, transcript, and details panel
// all fit. At 1280px the details panel would squeeze the transcript to ~400px.
const WIDE_QUERY = "(min-width: 90rem)";

const RAIL_BUTTON_CLASS =
  "h-10 gap-3 rounded-lg px-2.5 text-dashboard-text-muted group-data-[collapsible=icon]:size-10! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0! data-active:bg-dashboard-accent/[0.12] data-active:font-normal data-active:text-dashboard-accent-text [&_svg]:size-5";

const RAIL_LABEL_CLASS = "group-data-[collapsible=icon]:hidden";

// 200px sidebar, or a 56px rail with 40px targets. At 1920px the outline still
// fits beside an open details panel.
const RAIL_STYLE = {
  "--sidebar-width": "12.5rem",
  "--sidebar-width-icon": "3.5rem",
} as CSSProperties;

function readOpenPreference(): boolean {
  try {
    return window.localStorage.getItem(OPEN_KEY) !== "false";
  } catch {
    return true;
  }
}

function writeOpenPreference(open: boolean) {
  try {
    window.localStorage.setItem(OPEN_KEY, String(open));
  } catch {
    // The toggle still works for this page when browser storage is unavailable.
  }
}

function useWideWindow(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(WIDE_QUERY);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => window.matchMedia(WIDE_QUERY).matches,
    () => false,
  );
}

/**
 * Own the nav sidebar state. Wide windows show labels unless the viewer
 * collapsed the sidebar; narrower desktop windows always use the icon rail
 * and keep the saved choice for later. Cmd/Ctrl+B toggles it.
 */
export function useNavSidebar() {
  const wide = useWideWindow();
  const [preferOpen, setPreferOpen] = useState(readOpenPreference);

  const toggle = () => setPreferOpen((current) => !current);

  useEffect(() => {
    writeOpenPreference(preferOpen);
  }, [preferOpen]);

  useEffect(() => {
    if (!wide) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.key.toLowerCase() !== "b" ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey
      ) {
        return;
      }
      event.preventDefault();
      setPreferOpen((current) => !current);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [wide]);

  return { canExpand: wide, open: wide && preferOpen, toggle };
}

/**
 * Lay out the desktop nav sidebar beside the page. The provider's spacer
 * keeps page content clear of it in both widths.
 */
export function NavRailProvider(props: { children: ReactNode; open: boolean }) {
  return (
    <SidebarProvider open={props.open} style={RAIL_STYLE}>
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
          aria-label="Search"
          className={RAIL_BUTTON_CLASS}
          onClick={props.onSearch}
          tooltip={{
            children: `Search ${COMMAND_PALETTE_SHORTCUT}`,
            size: "compact",
            sideOffset: 6,
          }}
        >
          <Search aria-hidden="true" strokeWidth={1.9} />
          <span className={cn("flex-1", RAIL_LABEL_CLASS)}>Search</span>
          <kbd
            className={cn(
              "font-sans text-xs text-dashboard-text-faint",
              RAIL_LABEL_CLASS,
            )}
          >
            {COMMAND_PALETTE_SHORTCUT}
          </kbd>
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

function RailToggle(props: { open: boolean; onToggle(): void }) {
  const label = props.open ? "Collapse sidebar" : "Expand sidebar";
  const Icon = props.open ? ChevronsLeft : ChevronsRight;
  return (
    <SidebarMenuButton
      aria-expanded={props.open}
      aria-keyshortcuts="Meta+B Control+B"
      aria-label={label}
      className="size-8! justify-center rounded-lg p-0! text-dashboard-text-faint hover:text-dashboard-text [&_svg]:size-4"
      onClick={props.onToggle}
      tooltip={{ children: label, size: "compact", sideOffset: 6 }}
    >
      <Icon aria-hidden="true" strokeWidth={2} />
    </SidebarMenuButton>
  );
}

/**
 * Desktop primary navigation. Wide windows show icons and labels; narrower
 * desktop windows show the icon rail. Mobile uses `DashboardHeader`.
 */
export function NavRail(props: {
  canExpand: boolean;
  navItems: DashboardHeaderNavItem[];
  onSearch(): void;
  onToggle(): void;
  open: boolean;
  profile?: ReactNode;
  usage?: ReactNode;
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
          {props.canExpand ? (
            <RailToggle onToggle={props.onToggle} open={props.open} />
          ) : null}
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
      {props.usage || props.profile ? (
        <SidebarFooter className="gap-1 px-3 pb-3 group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:px-2">
          {props.usage ? (
            <SidebarMenu className="group-data-[collapsible=icon]:items-center">
              {props.usage}
            </SidebarMenu>
          ) : null}
          {props.profile}
        </SidebarFooter>
      ) : null}
    </Sidebar>
  );
}
