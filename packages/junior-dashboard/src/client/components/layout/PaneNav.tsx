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
  type ReactNode,
} from "react";
import { Link, useMatch } from "react-router";

import { getDashboardAgentName } from "../../agentName";
import { HeaderIconButton } from "../../conversations/ConversationHeaderActions";
import { isPlatformShortcut, platformShortcut } from "../../keyboard";
import { DESKTOP_LAYOUT_QUERY } from "../../layoutMedia";
import { cn } from "../../styles";
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

// Rows stay lighter than the conversation titles below them. The 0.875rem
// icon column lines their labels up with those titles.
const ROW_CLASS =
  "grid h-9 w-full min-w-0 grid-cols-[0.875rem_minmax(0,1fr)_auto] items-center gap-2 rounded-lg border-0 px-3 text-left font-sans text-sm font-normal no-underline transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus/70 [&_svg]:size-4 [&_svg]:justify-self-center";

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

function usePaneNav(): PaneNavValue {
  const value = useContext(PaneNavContext);
  if (!value) throw new Error("Pane navigation requires PaneNavProvider");
  return value;
}

/**
 * Own the desktop pane: the primary destinations that every list pane shows
 * at its top, the profile at its bottom, and whether the pane shows. Cmd/Ctrl+B
 * shows or hides it on desktop. Children lay out in one row: the pane, then
 * the page.
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
      <div className="flex min-h-svh w-full">{props.children}</div>
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
      <PanelLeft aria-hidden="true" size={15} strokeWidth={2} />
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
      <Search aria-hidden="true" size={15} strokeWidth={2} />
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
    <div className="hidden items-center gap-0.5 md:flex">
      <PaneToggle open={false} />
      <PaneSearch />
      {pane.spend ? (
        <div className="mr-3 ml-2 hidden lg:flex">{pane.spend}</div>
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
        <span className="rounded-full bg-dashboard-accent px-1.5 text-2xs font-semibold leading-4 tabular-nums text-dashboard-text-inverse">
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
        "grid gap-0.5 border-b border-b-dashboard-border-subtle px-3 pb-2 max-md:hidden",
        PANE_EDGE_CLASS,
      )}
    >
      {/* Same height as the page headers, so the row reads as their start. */}
      <div className="flex h-12 items-center justify-between gap-2">
        <Link
          aria-label={`${name} home`}
          className="flex min-w-0 items-center gap-1.5 rounded-lg text-inherit no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus/70"
          to="/"
        >
          <JuniorLogo />
          <span className="truncate font-sans text-sm font-semibold">
            {name}
          </span>
        </Link>
        <div className="flex shrink-0 items-center gap-0.5">
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
 * Lay out one desktop pane: the primary destinations, then the page's own
 * list, then the profile. A page without a list passes no children. Phones
 * show only the list, under the app header. Children draw their own pane
 * edge, like `PANE_EDGE_CLASS`.
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
        "flex h-full min-h-0 min-w-0 flex-col overflow-hidden",
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
    </div>
  );
}
