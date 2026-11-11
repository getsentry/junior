import {
  Inbox,
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
  useSidebarFits,
} from "../../conversations/conversationSidebarLayout";
import { isPlatformShortcut, platformShortcut } from "../../keyboard";
import { DESKTOP_LAYOUT_QUERY } from "../../layoutMedia";
import {
  FOCUS_REPLY_STATE,
  NEW_CONVERSATION_PATH,
} from "../../conversations/conversationRoutes";
import { cn } from "../../styles";
import {
  COMMAND_PALETTE_LABEL,
  COMMAND_PALETTE_SHORTCUT,
} from "../CommandPalette";
import { JuniorLogo } from "../JuniorLogo";
import type { DashboardHeaderNavItem } from "./DashboardHeader";
import { navItemIcon } from "./navIcons";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

const PANE_TOGGLE_SHORTCUT = platformShortcut("b");

/**
 * Shortcut text for Zen mode. It follows Zed's `workspace::ToggleAllDocks`;
 * VS Code's `⌘K Z` would clash with the command palette.
 */
export const ZEN_MODE_SHORTCUT = platformShortcut("y", { alt: true });

// The pane edge that the page lists draw too, so the nav, the list, and the
// profile read as one column.
const PANE_EDGE_CLASS =
  "border-r border-dashboard-border bg-dashboard-surface-panel";

type PaneNavValue = {
  navItems: DashboardHeaderNavItem[];
  onSearch(): void;
  /** False while the reader hides the pane on desktop, or in Zen mode. */
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
  /** The tab the highlight sat on last, so a remounted pane slides from it. */
  shownTab: { get(): string | undefined; set(key: string | undefined): void };
  zen: ZenMode;
};

/**
 * Zen mode hides the pane, and Conversation details where a page has them,
 * so the page fills the window. It overlays the pane and details choices
 * without changing them, so leaving it restores both. It lasts for the
 * session and exists on every desktop page.
 */
type ZenMode = {
  active: boolean;
  available: boolean;
  toggle(): void;
};

/** The tabs at the top of the pane. Each tab's list fills the pane. */
type PaneTab = "automations" | "inbox";

const TAB_ROOTS: Record<PaneTab, string> = {
  automations: "/automations",
  inbox: "/",
};

/** Name the tab that owns a path, if any. */
export function paneTabForPath(pathname: string): PaneTab | undefined {
  if (
    pathname === "/" ||
    pathname === "/conversations" ||
    pathname.startsWith("/conversations/")
  ) {
    return "inbox";
  }
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
 * Cmd/Ctrl+B shows or hides it on desktop, and Option/Alt+Cmd/Ctrl+Y
 * toggles Zen mode. Children lay out in one row: the
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
  const desktop = useSidebarFits();
  const [zenOn, setZenOn] = useState(false);
  const zenAvailable = desktop;
  const zenActive = zenOn && zenAvailable;
  const location = useLocation();
  const [tabPaths, setTabPaths] = useState<Record<PaneTab, string>>(TAB_ROOTS);
  const tabScroll = useRef(new Map<PaneTab, number>()).current;
  const shownTabKey = useRef<string | undefined>(undefined);
  const shownTab = useMemo(
    () => ({
      get: () => shownTabKey.current,
      set: (key: string | undefined) => {
        shownTabKey.current = key;
      },
    }),
    [],
  );
  // Remember where each tab was, so switching back reopens its selection,
  // its search, and (through `tabScroll`) its list position.
  const tab = paneTabForPath(location.pathname);
  const here = `${location.pathname}${location.search}`;
  if (tab && tabPaths[tab] !== here) {
    setTabPaths({ ...tabPaths, [tab]: here });
  }
  const [lastTab, setLastTab] = useState<PaneTab>("inbox");
  if (tab && tab !== lastTab) setLastTab(tab);
  const [width, setWidth] = useState(readSidebarWidth);
  const widthValue = useMemo(() => ({ setWidth, width }), [width]);
  const { onOpenChange } = props;
  const open = props.open && !zenActive;
  const setOpen = useCallback(
    (next: boolean, options?: { focus?: boolean }) => {
      focusToggle.current = Boolean(options?.focus);
      onOpenChange(next);
    },
    [onOpenChange],
  );
  const toggleZen = useCallback(() => setZenOn((current) => !current), []);
  const zen = useMemo(
    () => ({
      active: zenActive,
      available: zenAvailable,
      toggle: toggleZen,
    }),
    [toggleZen, zenActive, zenAvailable],
  );
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      // Phones have no pane to toggle and no Zen mode.
      if (!window.matchMedia(DESKTOP_LAYOUT_QUERY).matches) return;
      if (isPlatformShortcut(event, "y", { alt: true })) {
        if (!zenAvailable) return;
        event.preventDefault();
        toggleZen();
      } else if (isPlatformShortcut(event, "b")) {
        event.preventDefault();
        // In Zen mode the pane toggle leaves it, back to the pane as it was.
        if (zenActive) toggleZen();
        else setOpen(!open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, setOpen, toggleZen, zenActive, zenAvailable]);
  const value = useMemo(
    () => ({
      lastTab,
      navItems: props.navItems,
      onSearch: props.onSearch,
      open,
      profile: props.profile,
      setOpen,
      spend: props.spend,
      shownTab,
      tabPaths,
      tabScroll,
      takeToggleFocus: () => {
        const take = focusToggle.current;
        focusToggle.current = false;
        return take;
      },
      workspaceActive: props.workspaceActive,
      zen,
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
      shownTab,
      tabPaths,
      tabScroll,
      zen,
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

const NO_ZEN: ZenMode = { active: false, available: false, toggle() {} };

/**
 * Read Zen mode, for pages with details, the conversation menu, and the
 * palette. A page that renders on its own, such as in tests, has no Zen
 * mode.
 */
export function useZenMode(): ZenMode {
  return useContext(PaneNavContext)?.zen ?? NO_ZEN;
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
  // Zen mode leaves only the conversation. Its shortcut or menu row leaves.
  if (pane.open || pane.zen.active) return null;
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
  inbox: Inbox,
};

/** One pane tab, with where it opens and whether it shows now. */
type PaneTabLink = {
  active: boolean;
  count?: number;
  icon: LucideIcon;
  key: string;
  label: string;
  to: string;
};

/**
 * Build the pane tabs: Inbox and Automations, then any other
 * primary destination, such as a plugin page. A tab opens where the reader
 * left it. A press on the tab that shows now goes back to its root.
 */
function usePaneTabs(): PaneTabLink[] {
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
  const inbox = pane.navItems.find((item) => item.key === "inbox");
  const automations = pane.navItems.find((item) => item.key === "automations");
  const others = pane.navItems.filter(
    (item) => item.key !== "inbox" && item.key !== "automations",
  );
  return [
    tab("inbox", "Inbox", inbox?.count),
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
function PaneTabCount(props: { active?: boolean; count?: number }) {
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
 * The tab the highlight sits on. On a tab switch the pane remounts, so the
 * first frame keeps the tab that showed before and the next frame moves to
 * the new one, which lets the highlight slide and the labels fade.
 */
function useShownTab(current: string | undefined): string | undefined {
  const { shownTab } = usePaneNav();
  const [shown, setShown] = useState(() => shownTab.get() ?? current);
  useLayoutEffect(() => {
    shownTab.set(current);
    if (shown === current) return;
    const frame = requestAnimationFrame(() => setShown(current));
    return () => cancelAnimationFrame(frame);
  }, [current, shown, shownTab]);
  return shown;
}

// The container width at which every tab shows its label.
const TABS_LABELLED_REM = 22;

// A bit past the 180ms transitions, for when no transitionend fires.
const SWITCH_MS = 250;

/**
 * Where the shown tab ends up once the labels finish opening and closing.
 * Below `TABS_LABELLED_REM`, the other tabs close to their icon and the
 * shown tab takes the rest of the row. Above it, no tab changes size.
 */
function finalTabBox(nav: HTMLElement, target: HTMLElement) {
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const style = getComputedStyle(nav);
  const start = parseFloat(style.paddingLeft);
  const inner = nav.clientWidth - start - parseFloat(style.paddingRight);
  if (inner >= TABS_LABELLED_REM * rem) {
    return { left: target.offsetLeft, width: target.offsetWidth };
  }
  const gap = parseFloat(style.columnGap) || 0;
  const tabs = [...nav.querySelectorAll<HTMLElement>("a")];
  // Each tab at its content width without the label, as the other tabs
  // end up. The tab that showed before may hold free space as well. Plugin
  // tabs have no label and keep their size.
  const labelled = (tab: HTMLElement) =>
    Boolean(tab.querySelector("[data-tab-label]"));
  const closed = tabs.map((tab) => {
    if (!labelled(tab)) return tab.offsetWidth;
    const pad = getComputedStyle(tab);
    return [...tab.children].reduce(
      (sum, child) => {
        if (child.hasAttribute("data-tab-label")) return sum;
        const margin = getComputedStyle(child);
        return (
          sum +
          child.getBoundingClientRect().width +
          parseFloat(margin.marginLeft) +
          parseFloat(margin.marginRight)
        );
      },
      parseFloat(pad.paddingLeft) + parseFloat(pad.paddingRight),
    );
  });
  const index = tabs.indexOf(target);
  const before = closed
    .slice(0, index)
    .reduce((sum, width) => sum + width + gap, 0);
  const others = closed.reduce(
    (sum, width, at) => (at === index ? sum : sum + width + gap),
    0,
  );
  // A shown labelled tab takes the rest of the row.
  return {
    left: start + before,
    width: labelled(target) ? inner - others : target.offsetWidth,
  };
}

/**
 * Keep the highlight under the shown tab. A switch slides it to where the
 * tab ends up, while the labels open and close beside it. Other resizes,
 * such as a pane drag, move it at once.
 */
function useTabHighlight(shown: string | undefined) {
  const nav = useRef<HTMLElement>(null);
  const highlight = useRef<HTMLSpanElement>(null);
  const switching = useRef(false);
  const place = useCallback((animate: boolean) => {
    const box = highlight.current;
    const row = nav.current;
    if (!box || !row) return;
    const target = row.querySelector<HTMLElement>("[data-tab-shown]");
    box.hidden = !target;
    if (!target) return;
    const next = animate
      ? finalTabBox(row, target)
      : { left: target.offsetLeft, width: target.offsetWidth };
    if (!animate) box.style.transition = "none";
    box.style.width = `${next.width}px`;
    box.style.transform = `translateX(${next.left}px)`;
    if (!animate) {
      void box.offsetWidth;
      box.style.transition = "";
    }
  }, []);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => {
      // During a switch the labels resize the tabs; the slide covers it.
      if (!switching.current) place(false);
    });
    for (const tab of nav.current?.querySelectorAll("a") ?? []) {
      observer.observe(tab);
    }
    return () => observer.disconnect();
  }, [place]);
  const placed = useRef(false);
  useLayoutEffect(() => {
    const animate = placed.current;
    placed.current = true;
    place(animate);
    if (!animate) return;
    switching.current = true;
    const timer = window.setTimeout(() => {
      switching.current = false;
      // Settle on the tab's real box, in case the prediction missed.
      place(false);
    }, SWITCH_MS);
    return () => {
      window.clearTimeout(timer);
      switching.current = false;
    };
  }, [place, shown]);
  return { highlight, nav };
}

/**
 * The pane tabs as one segmented control. Each tab shows its icon and label.
 * When the labels do not fit, the other tabs show only their icon, with the
 * label as tooltip; the tab that shows now and the Inbox count stay.
 * Destinations past the three tabs, such as plugin pages, always show as
 * icons. One highlight slides between tabs, and labels fade as they open or
 * close; reduced motion turns both off.
 */
export function PaneTabs(props: { className?: string }) {
  const tabs = usePaneTabs();
  const main = tabs.slice(0, 3);
  const extra = tabs.slice(3);
  const shown = useShownTab(tabs.find((tab) => tab.active)?.key);
  const { highlight, nav } = useTabHighlight(shown);
  return (
    <nav
      aria-label="Primary"
      className={cn(
        "@container/tabs relative flex min-w-0 gap-0.5 rounded-xl bg-dashboard-fill-soft p-0.5",
        props.className,
      )}
      ref={nav}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-0.5 bottom-0.5 left-0 rounded-[0.625rem] bg-dashboard-surface-raised shadow-sm ring-1 ring-dashboard-border transition-[transform,width] duration-180 ease-out motion-reduce:transition-none"
        ref={highlight}
      />
      {main.map((tab) => {
        const Icon = tab.icon;
        const on = tab.key === shown;
        return (
          // 22rem fits the three labelled tabs with the Inbox count.
          <Tooltip key={tab.key}>
            <TooltipTrigger
              render={
                <Link
                  aria-current={tab.active ? "page" : undefined}
                  aria-label={
                    tab.count ? `${tab.label}, ${tab.count} waiting` : tab.label
                  }
                  className={cn(
                    "relative flex h-8 min-w-0 items-center justify-center rounded-[0.625rem] px-2 font-sans text-xs font-medium no-underline transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus/70",
                    on
                      ? "flex-auto text-dashboard-text"
                      : "flex-none text-dashboard-text-muted hover:bg-dashboard-fill-hover hover:text-dashboard-text @[22rem]/tabs:flex-auto",
                  )}
                  data-tab-shown={on ? "" : undefined}
                  to={tab.to}
                />
              }
            >
              <Icon
                aria-hidden="true"
                className="size-4 shrink-0"
                strokeWidth={1.9}
              />
              {/* The label column opens from zero width, so it fades in as
                  the tab widens, and the reverse as it closes. */}
              <span
                data-tab-label=""
                className={cn(
                  "grid min-w-0 transition-[grid-template-columns,opacity,visibility] duration-180 ease-out motion-reduce:transition-none",
                  on
                    ? "grid-cols-[1fr] opacity-100"
                    : "invisible grid-cols-[0fr] opacity-0 @[22rem]/tabs:visible @[22rem]/tabs:grid-cols-[1fr] @[22rem]/tabs:opacity-100",
                )}
              >
                <span className="min-w-0 overflow-hidden">
                  <span className="block truncate pl-1.5">{tab.label}</span>
                </span>
              </span>
              {tab.count ? (
                <span className="ml-1.5">
                  <PaneTabCount active={on} count={tab.count} />
                </span>
              ) : null}
            </TooltipTrigger>
            <TooltipContent size="compact">{tab.label}</TooltipContent>
          </Tooltip>
        );
      })}
      {extra.map((tab) => {
        const Icon = tab.icon;
        const on = tab.key === shown;
        return (
          <Link
            aria-current={tab.active ? "page" : undefined}
            aria-label={tab.label}
            className={cn(
              "relative grid size-8 shrink-0 place-items-center rounded-[0.625rem] no-underline transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus/70",
              on
                ? "text-dashboard-text"
                : "text-dashboard-text-muted hover:bg-dashboard-fill-hover hover:text-dashboard-text",
            )}
            data-tab-shown={on ? "" : undefined}
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

function runNewAction(
  action: PaneNewAction,
  navigate: ReturnType<typeof useNavigate>,
) {
  if (action.onClick) action.onClick();
  // The reader asked to type, so the composer takes focus on phones too.
  else navigate(action.to, { state: FOCUS_REPLY_STATE });
}

/** New where a page names nothing else, such as the Inbox and areas. */
const NEW_CONVERSATION_ACTION: PaneNewAction = {
  label: "New conversation",
  to: NEW_CONVERSATION_PATH,
};

/** A square "+" in the pane header. Its name says what the tab creates. */
function NewButton(props: { action: PaneNewAction }) {
  const navigate = useNavigate();
  return (
    <HeaderIconButton
      label={props.action.label}
      onClick={() => runNewAction(props.action, navigate)}
    >
      <Plus aria-hidden="true" size={16} strokeWidth={2.2} />
    </HeaderIconButton>
  );
}

/**
 * Head the pane in one row at the page header height: home, the search bar,
 * New, and the pane toggle. The tabs sit under its rule.
 */
function PaneNavHeader(props: { newAction: PaneNewAction }) {
  const name = getDashboardAgentName();
  return (
    <div className={cn("max-md:hidden", PANE_EDGE_CLASS)}>
      {/* Same height and rule as the page headers. The logo sits on the
          icon axis; the toggle ends on the right content edge, 24px in,
          like row dates and counts. */}
      <div className="box-content flex h-header items-center gap-1.5 border-b border-b-dashboard-border pr-4 pl-3">
        <Link
          aria-label={`${name} home`}
          className="grid size-8 shrink-0 place-items-center rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus/70"
          to="/"
        >
          <JuniorLogo size="sm" />
        </Link>
        <PaneSearchBar />
        <NewButton action={props.newAction} />
        <PaneToggle open />
      </div>
      <div className="border-b border-b-dashboard-border-subtle px-3 py-3">
        <PaneTabs />
      </div>
    </div>
  );
}

/**
 * Open the command palette from a bar that fills the header row, with its
 * shortcut shown. The page header keeps the compact `PaneSearch` while the
 * pane is hidden.
 */
function PaneSearchBar() {
  const pane = usePaneNav();
  return (
    <button
      aria-keyshortcuts="Meta+K Control+K"
      className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg border border-dashboard-border bg-dashboard-control px-2.5 text-left font-sans text-sm text-dashboard-text-muted transition-colors hover:border-dashboard-border-interactive hover:text-dashboard-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus/70"
      onClick={pane.onSearch}
      type="button"
    >
      <Search
        aria-hidden="true"
        className="size-4 shrink-0"
        strokeWidth={1.9}
      />
      <span className="min-w-0 flex-1 truncate">Search</span>
      <kbd className="rounded border border-dashboard-border px-1.5 py-0.5 font-sans text-2xs text-dashboard-text-faint">
        {COMMAND_PALETTE_SHORTCUT}
      </kbd>
    </button>
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
 * names what New in the header creates; a new conversation by default.
 */
export function ListPane(props: {
  children?: ReactNode;
  className?: string;
  newAction?: PaneNewAction;
  tab?: PaneTab;
}) {
  const pane = usePaneNav();
  const scroll = usePaneScrollMemory(props.tab);
  return (
    <div
      className={cn(
        "relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden md:w-[var(--pane-width)] md:shrink-0",
        !pane.open && "md:hidden",
        props.className,
      )}
    >
      <PaneNavHeader newAction={props.newAction ?? NEW_CONVERSATION_ACTION} />
      <div
        className={cn(
          "relative min-h-0 flex-1",
          !props.children && PANE_EDGE_CLASS,
        )}
        onScrollCapture={scroll.onScrollCapture}
        ref={scroll.ref}
      >
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
