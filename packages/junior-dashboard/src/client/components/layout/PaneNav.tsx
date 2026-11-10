import {
  MessagesSquare,
  PanelLeft,
  Search,
  SquarePen,
  type LucideIcon,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Link, useMatch } from "react-router";

import { getDashboardAgentName } from "../../agentName";
import { HeaderIconButton } from "../../conversations/ConversationHeaderActions";
import {
  readSidebarWidth,
  saveSidebarWidth,
  SIDEBAR_WIDTH,
} from "../../conversations/conversationSidebarLayout";
import { isPlatformShortcut, platformShortcut } from "../../keyboard";
import { DESKTOP_LAYOUT_QUERY } from "../../layoutMedia";
import { cn } from "../../styles";
import { SIDEBAR_ROW_GRID_CLASS } from "./sidebarGrid";
import {
  COMMAND_PALETTE_LABEL,
  COMMAND_PALETTE_SHORTCUT,
} from "../CommandPalette";
import { JuniorLogo } from "../JuniorLogo";
import type { DashboardHeaderNavItem } from "./DashboardHeader";
import { navItemIcon } from "./navIcons";

const PANE_TOGGLE_SHORTCUT = platformShortcut("b");

// The pane edge that the page lists draw too, so the nav, the list, and the
// profile read as one column.
const PANE_EDGE_CLASS =
  "border-r border-dashboard-border bg-dashboard-surface-panel";

// Rows use the pane grid (`SIDEBAR_ROW_GRID_CLASS`), so icons, the logo, and
// the avatar share one centre axis and every label starts on the
// conversation title edge.
const ROW_CLASS = cn(
  SIDEBAR_ROW_GRID_CLASS,
  "h-8 w-full min-w-0 items-center rounded-lg border-0 text-left font-sans text-sm font-normal no-underline transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus/70 [&_svg]:size-4",
);

const IDLE_ROW_CLASS =
  "bg-transparent text-dashboard-text-muted hover:bg-dashboard-fill-hover hover:text-dashboard-text";

const ACTIVE_ROW_CLASS =
  "bg-dashboard-accent/[0.12] text-dashboard-accent-text hover:bg-dashboard-accent/[0.16]";

type PaneNavValue = {
  navItems: DashboardHeaderNavItem[];
  onSearch(): void;
  /** False while the reader hides the pane on desktop. */
  open: boolean;
  profile?: ReactNode;
  /** Spend totals that the page header shows while the pane hides. */
  spend?: ReactNode;
  /** `focus` moves focus to the toggle that replaces the one pressed. */
  setOpen(open: boolean, options?: { focus?: boolean }): void;
  /** A toggle mounted by `setOpen` with `focus` takes focus once. */
  takeToggleFocus(): boolean;
  workspaceActive: boolean;
};

const PaneNavContext = createContext<PaneNavValue | null>(null);

type PaneWidthValue = { setWidth(width: number): void; width: number };

// Apart from `PaneNavContext`, so a drag renders only the resize handle.
const PaneWidthContext = createContext<PaneWidthValue | null>(null);

const RESIZE_KEY_STEP = 16;

function clampWidth(width: number): number {
  return Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, width));
}

function usePaneNav(): PaneNavValue {
  const value = useContext(PaneNavContext);
  if (!value) throw new Error("Pane navigation requires PaneNavProvider");
  return value;
}

/**
 * Own the desktop pane: the primary destinations that every list pane shows
 * at its top, the profile at its bottom, whether the pane shows, and its
 * width. The pane is part of the layout, so every page shares one width.
 * Cmd/Ctrl+B shows or hides it on desktop. Children lay out in one row: the
 * pane, then the page.
 */
export function PaneNavProvider(props: {
  children: ReactNode;
  navItems: DashboardHeaderNavItem[];
  onOpenChange(open: boolean): void;
  onSearch(): void;
  open: boolean;
  profile?: ReactNode;
  spend?: ReactNode;
  workspaceActive: boolean;
}) {
  const focusToggle = useRef(false);
  const [width, setWidth] = useState(readSidebarWidth);
  const widthValue = useMemo(() => ({ setWidth, width }), [width]);
  const { onOpenChange, open } = props;
  const setOpen = useCallback(
    (next: boolean, options?: { focus?: boolean }) => {
      focusToggle.current = Boolean(options?.focus);
      onOpenChange(next);
    },
    [onOpenChange],
  );
  useEffect(() => {
    const toggle = (event: KeyboardEvent) => {
      if (!isPlatformShortcut(event, "b") || event.repeat) return;
      // Phones have no pane to toggle.
      if (!window.matchMedia(DESKTOP_LAYOUT_QUERY).matches) return;
      event.preventDefault();
      setOpen(!open);
    };
    window.addEventListener("keydown", toggle);
    return () => window.removeEventListener("keydown", toggle);
  }, [open, setOpen]);
  const value = useMemo(
    () => ({
      navItems: props.navItems,
      onSearch: props.onSearch,
      open,
      profile: props.profile,
      setOpen,
      spend: props.spend,
      takeToggleFocus: () => {
        const take = focusToggle.current;
        focusToggle.current = false;
        return take;
      },
      workspaceActive: props.workspaceActive,
    }),
    [
      open,
      props.navItems,
      props.onSearch,
      props.profile,
      props.spend,
      props.workspaceActive,
      setOpen,
    ],
  );
  return (
    <PaneNavContext.Provider value={value}>
      <PaneWidthContext.Provider value={widthValue}>
        <div
          className="flex min-h-svh w-full"
          style={{ "--pane-width": `${width}px` } as CSSProperties}
        >
          {props.children}
        </div>
      </PaneWidthContext.Provider>
    </PaneNavContext.Provider>
  );
}

/** Read whether the desktop pane shows. */
export function usePaneOpen(): boolean {
  return usePaneNav().open;
}

/** Show or hide the desktop pane, as its toggles and Cmd/Ctrl+B do. */
export function useSetPaneOpen(): PaneNavValue["setOpen"] {
  return usePaneNav().setOpen;
}

function PaneToggle(props: { open: boolean }) {
  const pane = usePaneNav();
  const ref = useRef<HTMLButtonElement>(null);
  // A press on the other toggle hides it, so its focus moves here. The
  // pane header's toggle stays mounted while the pane hides, so only the
  // toggle that matches the pane state takes it.
  useEffect(() => {
    if (props.open === pane.open && pane.takeToggleFocus()) {
      ref.current?.focus();
    }
  }, [pane, props.open]);
  return (
    <HeaderIconButton
      expanded={props.open}
      keyShortcuts="Meta+B Control+B"
      label={props.open ? "Hide sidebar" : "Show sidebar"}
      onClick={() => pane.setOpen(!props.open, { focus: true })}
      ref={ref}
      shortcut={PANE_TOGGLE_SHORTCUT}
    >
      <PanelLeft aria-hidden="true" size={16} strokeWidth={1.9} />
    </HeaderIconButton>
  );
}

function PaneSearch() {
  const pane = usePaneNav();
  return (
    <HeaderIconButton
      keyShortcuts="Meta+K Control+K"
      label={COMMAND_PALETTE_LABEL}
      onClick={pane.onSearch}
      shortcut={COMMAND_PALETTE_SHORTCUT}
    >
      <Search aria-hidden="true" size={16} strokeWidth={1.9} />
    </HeaderIconButton>
  );
}

/**
 * The controls that stay while the pane is hidden: show it again, the
 * command palette, and the spend totals. Pages put them at the start of their
 * own header. Spend shows only where the header has room for it.
 */
export function PaneCollapsedControls() {
  const pane = usePaneNav();
  if (pane.open) return null;
  return (
    // `-ml-2` puts the toggle's icon on the pane's icon axis, 24px from the
    // edge, as the page title starts there without these controls.
    <div className="-ml-2 hidden items-center gap-1 md:flex">
      <PaneToggle open={false} />
      <PaneSearch />
      {pane.spend ? (
        <div className="mr-2 ml-2 hidden lg:flex">{pane.spend}</div>
      ) : null}
    </div>
  );
}

function PaneRow(props: {
  active?: boolean;
  count?: number;
  icon: LucideIcon;
  label: string;
  to: string;
}) {
  const Icon = props.icon;
  return (
    <Link
      aria-current={props.active ? "page" : undefined}
      className={cn(
        ROW_CLASS,
        props.active ? ACTIVE_ROW_CLASS : IDLE_ROW_CLASS,
      )}
      to={props.to}
    >
      <Icon aria-hidden="true" strokeWidth={1.9} />
      <span className="truncate">{props.label}</span>
      {props.count ? (
        <span className="grid h-5 min-w-5 place-items-center rounded-md bg-dashboard-accent px-1 text-2xs font-semibold tabular-nums text-dashboard-text-inverse">
          {props.count > 99 ? "99+" : props.count.toLocaleString("en-US")}
        </span>
      ) : null}
    </Link>
  );
}

function PaneNavItemRow(props: { item: DashboardHeaderNavItem }) {
  const active = useMatch({ end: false, path: props.item.to }) !== null;
  return (
    <PaneRow
      active={active}
      count={props.item.count}
      icon={navItemIcon(props.item.key)}
      label={props.item.label}
      to={props.item.to}
    />
  );
}

/**
 * Head the pane: home, the command palette, the pane toggle, a new
 * Conversation, and the primary destinations as labelled rows. Without
 * `onNewConversation`, new goes home, where the composer takes focus.
 */
function PaneNavHeader(props: { onNewConversation?(): void }) {
  const pane = usePaneNav();
  const name = getDashboardAgentName();
  return (
    <div
      className={cn(
        "grid gap-0.5 border-b border-b-dashboard-border-subtle px-3 pb-3 max-md:hidden",
        PANE_EDGE_CLASS,
      )}
    >
      {/* Same height and centre line as the page headers. The logo sits on
          the icon axis and the name on the label edge. The buttons end on
          the right content edge, 24px in, like row dates and counts. */}
      <div className={cn(SIDEBAR_ROW_GRID_CLASS, "h-12 items-center pr-1")}>
        <Link
          aria-label={`${name} home`}
          className="col-span-2 grid min-w-0 grid-cols-subgrid items-center rounded-lg text-inherit no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus/70"
          to="/"
        >
          <JuniorLogo size="sm" />
          <span className="truncate font-sans text-sm font-semibold">
            {name}
          </span>
        </Link>
        <div className="flex shrink-0 items-center gap-1">
          <PaneSearch />
          <PaneToggle open />
        </div>
      </div>
      {props.onNewConversation ? (
        <button
          className={cn(ROW_CLASS, IDLE_ROW_CLASS, "cursor-pointer")}
          onClick={props.onNewConversation}
          type="button"
        >
          <SquarePen aria-hidden="true" strokeWidth={1.9} />
          New conversation
        </button>
      ) : (
        <Link className={cn(ROW_CLASS, IDLE_ROW_CLASS)} to="/">
          <SquarePen aria-hidden="true" strokeWidth={1.9} />
          New conversation
        </Link>
      )}
      <nav aria-label="Primary" className="grid gap-0.5">
        <PaneRow
          active={pane.workspaceActive}
          icon={MessagesSquare}
          label="Conversations"
          to="/"
        />
        {pane.navItems.map((item) => (
          <PaneNavItemRow item={item} key={item.key} />
        ))}
      </nav>
    </div>
  );
}

/**
 * Resize the pane by drag or arrow keys. A drag far past the minimum width
 * hides the pane, as the toggle does.
 */
function PaneResizeHandle() {
  const pane = usePaneNav();
  const paneWidth = useContext(PaneWidthContext);
  if (!paneWidth) throw new Error("Pane resizing requires PaneNavProvider");
  const { setWidth, width } = paneWidth;

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = width;
    let next = startWidth;
    const move = (moveEvent: PointerEvent) => {
      const raw = startWidth + moveEvent.clientX - startX;
      if (raw < SIDEBAR_WIDTH.min / 2) {
        end();
        pane.setOpen(false, { focus: true });
        return;
      }
      next = clampWidth(raw);
      setWidth(next);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
      saveSidebarWidth(next);
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
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
    const next = clampWidth(width + step);
    setWidth(next);
    saveSidebarWidth(next);
  };

  return (
    <div
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      aria-valuemax={SIDEBAR_WIDTH.max}
      aria-valuemin={SIDEBAR_WIDTH.min}
      aria-valuenow={Math.round(width)}
      className="absolute inset-y-0 right-0 z-20 w-2 cursor-col-resize after:absolute after:inset-y-0 after:right-0 after:w-px after:transition-colors hover:after:bg-dashboard-border-interactive focus-visible:outline-none focus-visible:after:bg-dashboard-border-interactive max-md:hidden"
      onKeyDown={stepWidth}
      onPointerDown={startDrag}
      role="separator"
      tabIndex={0}
    />
  );
}

/**
 * Lay out one desktop pane: the primary destinations, then the page's own
 * list, then the profile. A page without a list passes no children. Phones
 * show only the list, under the app header. Children draw their own pane
 * edge, like `PANE_EDGE_CLASS`. On desktop the pane takes the shared width.
 */
export function ListPane(props: {
  children?: ReactNode;
  className?: string;
  onNewConversation?(): void;
}) {
  const pane = usePaneNav();
  return (
    <div
      className={cn(
        "relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden md:w-[var(--pane-width)] md:shrink-0",
        !pane.open && "md:hidden",
        props.className,
      )}
    >
      <PaneNavHeader onNewConversation={props.onNewConversation} />
      <div className={cn("min-h-0 flex-1", !props.children && PANE_EDGE_CLASS)}>
        {props.children}
      </div>
      {pane.profile ? (
        <div className={cn("px-3 pb-3 pt-2 max-md:hidden", PANE_EDGE_CLASS)}>
          {pane.profile}
        </div>
      ) : null}
      <PaneResizeHandle />
    </div>
  );
}
