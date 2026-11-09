import { PanelLeft, Search, SquarePen, type LucideIcon } from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Link, useMatch } from "react-router";

import { getDashboardAgentName } from "../../agentName";
import { JuniorLogo } from "../JuniorLogo";
import {
  Sidebar,
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
import {
  COMMAND_PALETTE_LABEL,
  COMMAND_PALETTE_SHORTCUT,
} from "../CommandPalette";
import { isPlatformShortcut } from "../../keyboard";
import { cn } from "../../styles";
import { FOCUS_CREATE_STATE } from "../../conversations/conversationRoutes";
import {
  readSidebarWidth,
  saveSidebarWidth,
  SIDEBAR_WIDTH,
  useConversationSidebarOpen,
} from "../../conversations/conversationSidebarLayout";

// The icon column is as wide as the status icon column of conversation rows,
// so nav labels start where conversation titles start.
const NAV_BUTTON_CLASS =
  "grid h-9 grid-cols-[0.875rem_minmax(0,1fr)] gap-2 rounded-lg px-3 text-dashboard-text-muted group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:size-10! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0! data-active:bg-dashboard-accent/[0.12] data-active:font-normal data-active:text-dashboard-accent-text [&_svg]:size-4 [&_svg]:justify-self-center";

const COLLAPSED_HIDDEN_CLASS = "group-data-[collapsible=icon]:hidden";

const RESIZE_KEY_STEP = 16;

type SidebarResize = {
  resize(width: number): void;
  setResizing(resizing: boolean): void;
  width: number;
};

const SidebarResizeContext = createContext<SidebarResize | null>(null);

function clampWidth(width: number): number {
  return Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, width));
}

/**
 * Lay out the desktop app sidebar beside the page. It keeps its open state
 * and width for this browser. Collapsed, it is an icon rail.
 */
export function AppSidebarProvider(props: { children: ReactNode }) {
  const [open, setOpen] = useConversationSidebarOpen();
  const [width, setWidth] = useState(readSidebarWidth);
  const [resizing, setResizing] = useState(false);
  const resize: SidebarResize = {
    resize: (next) => setWidth(clampWidth(next)),
    setResizing,
    width,
  };
  return (
    <SidebarResizeContext.Provider value={resize}>
      <SidebarProvider
        // The width follows the pointer while dragging, without the
        // collapse animation.
        className={cn(
          resizing &&
            "cursor-col-resize select-none **:data-[slot=sidebar-container]:transition-none **:data-[slot=sidebar-gap]:transition-none",
        )}
        onOpenChange={setOpen}
        open={open}
        style={
          {
            "--sidebar-width": `${width}px`,
            "--sidebar-width-icon": "3.5rem",
          } as CSSProperties
        }
      >
        {props.children}
      </SidebarProvider>
    </SidebarResizeContext.Provider>
  );
}

function NavItem(props: {
  active?: boolean;
  count?: number;
  icon: LucideIcon;
  label: string;
  state?: unknown;
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
        className={NAV_BUTTON_CLASS}
        isActive={props.active}
        render={
          <Link
            aria-current={props.active ? "page" : undefined}
            state={props.state}
            to={props.to}
          />
        }
        tooltip={{ children: label, size: "compact", sideOffset: 6 }}
      >
        <Icon aria-hidden="true" strokeWidth={1.9} />
        <span className={COLLAPSED_HIDDEN_CLASS}>{props.label}</span>
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

function SearchItem(props: { onSearch(): void }) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        aria-keyshortcuts="Meta+K Control+K"
        aria-label={COMMAND_PALETTE_LABEL}
        className={NAV_BUTTON_CLASS}
        onClick={props.onSearch}
        tooltip={{
          children: `${COMMAND_PALETTE_LABEL} ${COMMAND_PALETTE_SHORTCUT}`,
          size: "compact",
          sideOffset: 6,
        }}
      >
        <Search aria-hidden="true" strokeWidth={1.9} />
        <span className={cn("flex items-center", COLLAPSED_HIDDEN_CLASS)}>
          <span className="truncate">{COMMAND_PALETTE_LABEL}</span>
          <kbd className="ml-auto pl-2 font-sans text-xs text-dashboard-text-faint">
            {COMMAND_PALETTE_SHORTCUT}
          </kbd>
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function PageNavItem(props: { item: DashboardHeaderNavItem }) {
  const active = useMatch({ end: false, path: props.item.to }) !== null;
  return (
    <NavItem
      active={active}
      count={props.item.count}
      icon={navItemIcon(props.item.key)}
      label={props.item.label}
      to={props.item.to}
    />
  );
}

function SidebarToggle() {
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
  return (
    <SidebarMenuButton
      aria-expanded={open}
      aria-keyshortcuts="Meta+B Control+B"
      aria-label={label}
      className="size-8! shrink-0 justify-center rounded-lg p-0! text-dashboard-text-muted hover:text-dashboard-text [&_svg]:size-4"
      onClick={toggleSidebar}
      tooltip={{ children: label, size: "compact", sideOffset: 6 }}
    >
      <PanelLeft aria-hidden="true" strokeWidth={2} />
    </SidebarMenuButton>
  );
}

/** Drag or arrow-key the sidebar edge to change its width. */
function SidebarResizeHandle() {
  const resize = useContext(SidebarResizeContext);
  const widthRef = useRef(resize?.width ?? SIDEBAR_WIDTH.default);
  if (!resize) return null;
  widthRef.current = resize.width;

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = resize.width;
    resize.setResizing(true);
    const move = (moveEvent: PointerEvent) => {
      resize.resize(startWidth + moveEvent.clientX - startX);
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      resize.setResizing(false);
      saveSidebarWidth(widthRef.current);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  const stepWidth = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowLeft"
        ? -RESIZE_KEY_STEP
        : event.key === "ArrowRight"
          ? RESIZE_KEY_STEP
          : 0;
    if (!step) return;
    event.preventDefault();
    const next = clampWidth(resize.width + step);
    resize.resize(next);
    saveSidebarWidth(next);
  };

  return (
    <div
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      aria-valuemax={SIDEBAR_WIDTH.max}
      aria-valuemin={SIDEBAR_WIDTH.min}
      aria-valuenow={Math.round(resize.width)}
      className="absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:transition-colors hover:after:bg-dashboard-border-interactive focus-visible:outline-none focus-visible:after:bg-dashboard-border-interactive group-data-[collapsible=icon]:hidden"
      onKeyDown={stepWidth}
      onPointerDown={startDrag}
      role="separator"
      tabIndex={0}
    />
  );
}

/**
 * The one desktop sidebar. Its first row lines up with the page top bar and
 * holds the brand and the collapse toggle. Below it are the app destinations,
 * then the viewer's conversations, then the profile. Collapsed, it keeps the
 * destination icons and hides the conversations. `DashboardHeader` owns
 * mobile navigation.
 */
export function AppSidebar(props: {
  /** The conversation list. It shows only while the sidebar is expanded. */
  conversations: ReactNode;
  navItems: DashboardHeaderNavItem[];
  onSearch(): void;
  profile?: ReactNode;
}) {
  return (
    <Sidebar
      className="border-dashboard-border-strong pt-[env(safe-area-inset-top)]"
      collapsible="icon"
    >
      <SidebarHeader className="h-13 shrink-0 flex-row items-center justify-between gap-2 py-0 pr-2 pl-4 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-2">
        <Link
          aria-label={`${getDashboardAgentName()} home`}
          className={cn(
            "flex min-w-0 items-center gap-2 text-inherit no-underline",
            COLLAPSED_HIDDEN_CLASS,
          )}
          to="/"
        >
          <JuniorLogo />
          <span className="truncate font-sans text-sm font-semibold">
            {getDashboardAgentName()}
          </span>
        </Link>
        <SidebarToggle />
      </SidebarHeader>
      <SidebarGroup className="shrink-0 px-3 pt-1 pb-2 group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:px-2">
        <nav aria-label="Primary" className="w-full">
          <SidebarMenu className="gap-0.5 group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:gap-1.5">
            <NavItem
              icon={SquarePen}
              label="New conversation"
              state={FOCUS_CREATE_STATE}
              to="/"
            />
            <SearchItem onSearch={props.onSearch} />
            {props.navItems.map((item) => (
              <PageNavItem item={item} key={item.key} />
            ))}
          </SidebarMenu>
        </nav>
      </SidebarGroup>
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col",
          // Collapsed, the space stays so the profile keeps to the bottom.
          "group-data-[collapsible=icon]:invisible",
        )}
      >
        {props.conversations}
      </div>
      {props.profile ? (
        <SidebarFooter className="border-t border-dashboard-border px-3 py-2 group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:border-t-0 group-data-[collapsible=icon]:px-2">
          <SidebarMenu className="group-data-[collapsible=icon]:items-center">
            {props.profile}
          </SidebarMenu>
        </SidebarFooter>
      ) : null}
      <SidebarResizeHandle />
    </Sidebar>
  );
}
