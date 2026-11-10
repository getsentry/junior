import {
  Inbox,
  MessagesSquare,
  PanelLeft,
  Plus,
  Search,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Link, useLocation, useNavigate } from "react-router";

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
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { usePrototypeVariant } from "./prototypeVariant";
import type { DashboardHeaderNavItem } from "./DashboardHeader";
import { navItemIcon } from "./navIcons";

const PANE_TOGGLE_SHORTCUT = platformShortcut("b");

// The pane edge that the page lists draw too, so the nav, the list, and the
// profile read as one column.
const PANE_EDGE_CLASS =
  "border-r border-dashboard-border bg-dashboard-surface-panel";

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
  /** The tab the reader was on last, for the way back from other pages. */
  lastTab: PaneTab;
  /** The last path and search that each tab showed, so a tab reopens there. */
  tabPaths: Record<PaneTab, string>;
  /** Scroll offsets of each tab's list, kept while the tab is away. */
  tabScroll: Map<PaneTab, number>;
  tabValues: Record<string, string>;
  setTabValue(key: string, value: string): void;
};

/** The tabs at the top of the pane. Each tab's list fills the pane. */
export type PaneTab = "automations" | "conversations" | "inbox";

const TAB_ROOTS: Record<PaneTab, string> = {
  automations: "/automations",
  conversations: "/",
  inbox: "/review",
};

/** Name the tab that owns a path, if any. */
export function paneTabForPath(pathname: string): PaneTab | undefined {
  if (
    pathname === "/" ||
    pathname === "/conversations" ||
    pathname.startsWith("/conversations/")
  ) {
    return "conversations";
  }
  if (pathname === "/review") return "inbox";
  if (pathname === "/automations" || pathname.startsWith("/automations/")) {
    return "automations";
  }
  return undefined;
}

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
  const location = useLocation();
  const [tabPaths, setTabPaths] = useState<Record<PaneTab, string>>(TAB_ROOTS);
  const [tabValues, setTabValues] = useState<Record<string, string>>({});
  const tabScroll = useRef(new Map<PaneTab, number>()).current;
  const setTabValue = useCallback(
    (key: string, value: string) =>
      setTabValues((current) => ({ ...current, [key]: value })),
    [],
  );
  // Remember where each tab was, so switching back reopens its selection,
  // its search, and (through `tabScroll`) its list position.
  const tab = paneTabForPath(location.pathname);
  const here = `${location.pathname}${location.search}`;
  if (tab && tabPaths[tab] !== here) {
    setTabPaths({ ...tabPaths, [tab]: here });
  }
  const [lastTab, setLastTab] = useState<PaneTab>("conversations");
  if (tab && tab !== lastTab) setLastTab(tab);
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
      lastTab,
      navItems: props.navItems,
      onSearch: props.onSearch,
      open,
      profile: props.profile,
      setOpen,
      spend: props.spend,
      setTabValue,
      tabPaths,
      tabScroll,
      tabValues,
      takeToggleFocus: () => {
        const take = focusToggle.current;
        focusToggle.current = false;
        return take;
      },
      workspaceActive: props.workspaceActive,
    }),
    [
      lastTab,
      open,
      props.navItems,
      props.onSearch,
      props.profile,
      props.spend,
      props.workspaceActive,
      setOpen,
      setTabValue,
      tabPaths,
      tabScroll,
      tabValues,
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

const TAB_LABELS: Record<PaneTab, string> = {
  automations: "Automations",
  conversations: "Conversations",
  inbox: "Inbox",
};

/** The way back to the tab the reader came from, where it left off. */
export function usePaneBackToTab(): { label: string; to: string } {
  const pane = usePaneNav();
  return { label: TAB_LABELS[pane.lastTab], to: pane.tabPaths[pane.lastTab] };
}

/** Read whether the desktop pane shows. */
export function usePaneOpen(): boolean {
  return usePaneNav().open;
}

/**
 * Read whether the pane shows, for page chrome that can also render on its
 * own, such as in tests. False without a pane.
 */
export function usePaneShows(): boolean {
  return useContext(PaneNavContext)?.open ?? false;
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

const TAB_ICONS: Record<PaneTab, LucideIcon> = {
  automations: Zap,
  conversations: MessagesSquare,
  inbox: Inbox,
};

/** One pane tab, with where it opens and whether it shows now. */
export type PaneTabLink = {
  active: boolean;
  count?: number;
  icon: LucideIcon;
  key: string;
  label: string;
  to: string;
};

/**
 * Build the pane tabs: Conversations, Inbox, and Automations, then any other
 * primary destination, such as a plugin page. A tab opens where the reader
 * left it. A press on the tab that shows now goes back to its root.
 */
export function usePaneTabs(): PaneTabLink[] {
  const pane = usePaneNav();
  const { pathname } = useLocation();
  const current = paneTabForPath(pathname);
  const tab = (key: PaneTab, label: string, count?: number): PaneTabLink => ({
    active: current === key,
    count,
    icon: TAB_ICONS[key],
    key,
    label,
    to: current === key ? TAB_ROOTS[key] : pane.tabPaths[key],
  });
  const review = pane.navItems.find((item) => item.key === "review");
  const automations = pane.navItems.find((item) => item.key === "automations");
  const others = pane.navItems.filter(
    (item) => item.key !== "review" && item.key !== "automations",
  );
  return [
    tab("conversations", "Conversations"),
    ...(review ? [tab("inbox", review.label, review.count)] : []),
    ...(automations ? [tab("automations", automations.label)] : []),
    ...others.map((item) => ({
      active: pathname === item.to || pathname.startsWith(`${item.to}/`),
      icon: navItemIcon(item.key),
      key: item.key,
      label: item.label,
      to: item.to,
    })),
  ];
}

/** Show a count on a tab. The Inbox count shows on every tab. */
export function PaneTabCount(props: { active?: boolean; count?: number }) {
  if (!props.count) return null;
  return (
    <span
      className={cn(
        "grid h-4 min-w-4 place-items-center rounded-full px-1 text-2xs font-semibold tabular-nums",
        props.active
          ? "bg-dashboard-accent text-dashboard-text-inverse"
          : "bg-dashboard-accent/80 text-dashboard-text-inverse",
      )}
    >
      {props.count > 99 ? "99+" : props.count.toLocaleString("en-US")}
    </span>
  );
}

/**
 * The pane tabs as one segmented control. Labels show when the pane is wide
 * enough; a narrow pane shows icons. Destinations past the three tabs, such
 * as plugin pages, always show as icons.
 */
export function PaneTabs(props: { className?: string }) {
  const tabs = usePaneTabs();
  const main = tabs.slice(0, 3);
  const extra = tabs.slice(3);
  return (
    <nav
      aria-label="Primary"
      className={cn(
        "@container/tabs flex min-w-0 gap-0.5 rounded-xl bg-dashboard-fill-soft p-0.5",
        props.className,
      )}
    >
      {main.map((tab) => {
        const Icon = tab.icon;
        return (
          <Link
            aria-current={tab.active ? "page" : undefined}
            aria-label={
              tab.count ? `${tab.label}, ${tab.count} waiting` : tab.label
            }
            className={cn(
              "flex h-8 min-w-0 flex-auto items-center justify-center gap-1.5 rounded-[0.625rem] px-2 font-sans text-xs font-medium no-underline transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus/70",
              tab.active
                ? "bg-dashboard-surface-raised text-dashboard-text shadow-sm ring-1 ring-dashboard-border"
                : "text-dashboard-text-muted hover:bg-dashboard-fill-hover hover:text-dashboard-text",
            )}
            key={tab.key}
            title={tab.label}
            to={tab.to}
          >
            <Icon
              aria-hidden="true"
              className="size-4 shrink-0 @[17.5rem]/tabs:hidden"
              strokeWidth={1.9}
            />
            <span className="hidden truncate @[17.5rem]/tabs:inline">
              {tab.label}
            </span>
            <PaneTabCount active={tab.active} count={tab.count} />
          </Link>
        );
      })}
      {extra.map((tab) => {
        const Icon = tab.icon;
        return (
          <Link
            aria-current={tab.active ? "page" : undefined}
            aria-label={tab.label}
            className={cn(
              "grid size-8 shrink-0 place-items-center rounded-[0.625rem] no-underline transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus/70",
              tab.active
                ? "bg-dashboard-surface-raised text-dashboard-text shadow-sm ring-1 ring-dashboard-border"
                : "text-dashboard-text-muted hover:bg-dashboard-fill-hover hover:text-dashboard-text",
            )}
            key={tab.key}
            title={tab.label}
            to={tab.to}
          >
            <Icon aria-hidden="true" className="size-4" strokeWidth={1.9} />
          </Link>
        );
      })}
    </nav>
  );
}

/** What "New" does on the tab that shows now. */
export type PaneNewAction = { label: string } & (
  | { onClick(): void; to?: undefined }
  | { onClick?: undefined; to: string }
);

/**
 * The extended "New" button. In the pane it floats at the bottom right of
 * the list, never at the page's bottom right, where the composer's Send is.
 * `inline` puts it in a list header, as phones show it above the list.
 */
export function NewButton(props: {
  action: PaneNewAction;
  className?: string;
  inline?: boolean;
}) {
  const navigate = useNavigate();
  return (
    <button
      aria-label={props.action.label}
      className={cn(
        "inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border-0 bg-dashboard-accent font-sans text-sm font-semibold text-dashboard-text-inverse transition-[background-color,box-shadow,transform] duration-200 hover:bg-dashboard-accent/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus active:scale-[0.97]",
        props.inline
          ? "h-9 px-3.5"
          : "h-10 px-4 shadow-[0_6px_20px_-6px_rgb(0_0_0/0.55),0_1px_2px_rgb(0_0_0/0.25)] hover:shadow-[0_10px_24px_-8px_rgb(0_0_0/0.6),0_1px_2px_rgb(0_0_0/0.25)]",
        props.className,
      )}
      data-new-button=""
      onClick={() => {
        if (props.action.onClick) props.action.onClick();
        else navigate(props.action.to);
      }}
      title={props.action.label}
      type="button"
    >
      <Plus aria-hidden="true" className="size-4" strokeWidth={2.4} />
      New
    </button>
  );
}

/**
 * Prototype: which New control the pane shows. `?new=fab` (the default) or
 * `?new=bar`, so reviewers can compare them.
 */
function useNewButtonVariant() {
  return usePrototypeVariant("new", ["fab", "bar"]);
}

function runNewAction(
  action: PaneNewAction,
  navigate: ReturnType<typeof useNavigate>,
) {
  if (action.onClick) action.onClick();
  else navigate(action.to);
}

/**
 * Variant A: a round, elevated floating action button over the bottom
 * right of the list, as in Google Inbox. Its name follows the tab.
 */
function NewFab(props: { action: PaneNewAction }) {
  const navigate = useNavigate();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-label={props.action.label}
            className="absolute right-4 bottom-4 z-20 grid size-14 cursor-pointer place-items-center rounded-full border-0 bg-dashboard-accent text-dashboard-text-inverse shadow-[0_8px_24px_-6px_rgb(0_0_0/0.6),0_2px_6px_rgb(0_0_0/0.3)] transition-[background-color,box-shadow,transform] duration-200 hover:bg-dashboard-accent/90 hover:shadow-[0_12px_30px_-6px_rgb(0_0_0/0.65),0_3px_8px_rgb(0_0_0/0.3)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus active:scale-95 max-md:hidden"
            data-new-button="fab"
            onClick={() => runNewAction(props.action, navigate)}
            type="button"
          >
            <Plus aria-hidden="true" className="size-6" strokeWidth={2.4} />
          </button>
        }
      />
      <TooltipContent side="left">{props.action.label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Variant B: a full-width button pinned under the list, above the profile
 * footer. It names what it creates, such as "New conversation".
 */
function NewBar(props: { action: PaneNewAction }) {
  const navigate = useNavigate();
  return (
    <div className={cn("px-3 pt-2 max-md:hidden", PANE_EDGE_CLASS)}>
      <button
        className="flex h-9 w-full cursor-pointer items-center justify-center gap-2 rounded-lg border-0 bg-dashboard-accent font-sans text-sm font-semibold text-dashboard-text-inverse transition-colors hover:bg-dashboard-accent/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus"
        data-new-button="bar"
        onClick={() => runNewAction(props.action, navigate)}
        type="button"
      >
        <Plus aria-hidden="true" className="size-4" strokeWidth={2.4} />
        {props.action.label}
      </button>
    </div>
  );
}

/**
 * Head the pane: home, the command palette, the pane toggle, then the tabs.
 */
function PaneNavHeader() {
  const name = getDashboardAgentName();
  return (
    <div
      className={cn(
        "grid gap-1 border-b border-b-dashboard-border-subtle px-3 pb-3 max-md:hidden",
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
      <PaneTabs />
    </div>
  );
}

/**
 * Keep one tab's list scroll position while another tab shows. The list
 * unmounts on a tab switch, so its offset is saved on scroll and put back
 * once the list has rows again.
 */
function usePaneScrollMemory(tab: PaneTab | undefined) {
  const pane = usePaneNav();
  const ref = useRef<HTMLDivElement>(null);
  const { tabScroll } = pane;
  useLayoutEffect(() => {
    const saved = tab ? tabScroll.get(tab) : undefined;
    if (!saved || !ref.current) return;
    let frame = 0;
    let tries = 0;
    const restore = () => {
      const scroller = findScroller(ref.current);
      if (scroller && scroller.scrollHeight - scroller.clientHeight >= saved) {
        scroller.scrollTop = saved;
        return;
      }
      if (++tries < 30) frame = requestAnimationFrame(restore);
    };
    restore();
    return () => cancelAnimationFrame(frame);
  }, [tab, tabScroll]);
  return {
    onScrollCapture: (event: { target: EventTarget }) => {
      if (tab && event.target instanceof HTMLElement) {
        tabScroll.set(tab, event.target.scrollTop);
      }
    },
    ref,
  };
}

function findScroller(root: HTMLElement | null): HTMLElement | undefined {
  if (!root) return undefined;
  for (const element of root.querySelectorAll<HTMLElement>("*")) {
    const overflow = getComputedStyle(element).overflowY;
    if (
      (overflow === "auto" || overflow === "scroll") &&
      element.scrollHeight > element.clientHeight
    ) {
      return element;
    }
  }
  return undefined;
}

/** Read and set one value that a tab keeps while it is away, like a search. */
export function usePaneTabValue(
  key: string,
): [string, (value: string) => void] {
  const pane = usePaneNav();
  return [
    pane.tabValues[key] ?? "",
    (value: string) => pane.setTabValue(key, value),
  ];
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
 * Lay out one desktop pane: the tabs, then the tab's own list, then the
 * profile. A page without a list passes no children. Phones show only the
 * list, under the app header. Children draw their own pane edge, like
 * `PANE_EDGE_CLASS`. On desktop the pane takes the shared width. `newAction`
 * floats the "New" button at the bottom right of the list.
 */
export function ListPane(props: {
  children?: ReactNode;
  className?: string;
  newAction?: PaneNewAction;
  tab?: PaneTab;
}) {
  const pane = usePaneNav();
  const scroll = usePaneScrollMemory(props.tab);
  const newVariant = useNewButtonVariant();
  return (
    <div
      className={cn(
        "relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden md:w-[var(--pane-width)] md:shrink-0",
        !pane.open && "md:hidden",
        props.className,
      )}
    >
      <PaneNavHeader />
      <div
        className={cn(
          "relative min-h-0 flex-1",
          !props.children && PANE_EDGE_CLASS,
        )}
        onScrollCapture={scroll.onScrollCapture}
        ref={scroll.ref}
      >
        {props.children}
        {props.newAction && newVariant === "fab" ? (
          <NewFab action={props.newAction} />
        ) : null}
      </div>
      {props.newAction && newVariant === "bar" ? (
        <NewBar action={props.newAction} />
      ) : null}
      {pane.profile ? (
        <div className={cn("px-3 pb-3 pt-2 max-md:hidden", PANE_EDGE_CLASS)}>
          {pane.profile}
        </div>
      ) : null}
      <PaneResizeHandle />
    </div>
  );
}
