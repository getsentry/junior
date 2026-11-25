import { PanelLeft, Plus, Search } from "lucide-react";
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
  PANE_WIDTH,
  readPaneWidth,
  savePaneWidth,
  useSidebarFits,
} from "../../conversations/conversationSidebarLayout";
import { isPlatformShortcut, platformShortcut } from "../../keyboard";
import { DESKTOP_LAYOUT_QUERY } from "../../layoutMedia";
import {
  FOCUS_REPLY_STATE,
  COMPOSER_PATH,
} from "../../conversations/conversationRoutes";
import { useInboxConversationOrigin } from "../../inbox/inboxListState";
import { cn } from "../../styles";
import {
  COMMAND_PALETTE_LABEL,
  COMMAND_PALETTE_SHORTCUT,
} from "../../shell/components/CommandPalette";
import { JuniorLogo } from "../JuniorLogo";
import { PaneLinksContext } from "./SecondaryNavigation";
import { toolbarControlBoxClass } from "../ui/button";
import type { DashboardHeaderNavItem } from "../../shell/components/layout/DashboardHeader";
import {
  isInboxView,
  isOldAutomationsPath,
  paneRowForPath,
  paneRowLabel,
  paneRowMark,
  paneRowRoot,
  type PaneRow,
  type PaneRowMark,
} from "./paneRows";
import { NAV_PAGES } from "../../navPages";

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
  /** The row that owns the page now, if any. */
  currentRow?: PaneRow;
  /** How `currentRow` marks the page. */
  currentMark?: PaneRowMark;
  /** The row the reader was on last, for the way back from other pages. */
  lastRow: PaneRow;
  /** The last path and search that each row showed, so a row reopens there. */
  rowPaths: Partial<Record<PaneRow, string>>;
  /** Scroll offsets by list, such as the pane's and each row's page. */
  scroll: Map<string, number>;
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

const PaneNavContext = createContext<PaneNavValue | null>(null);

type PaneWidthValue = { setWidth(width: number): void; width: number };

// Apart from `PaneNavContext`, so a drag renders only the resize handle.
const PaneWidthContext = createContext<PaneWidthValue | null>(null);

// The pane width is in rem, so the pane keeps room for its text when the
// reader changes the browser font size. One arrow press moves it 1rem.
const RESIZE_KEY_STEP = 1;

function clampWidth(width: number): number {
  return Math.min(PANE_WIDTH.max, Math.max(PANE_WIDTH.min, width));
}

function rootFontPx(): number {
  return parseFloat(getComputedStyle(document.documentElement).fontSize);
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
  const scroll = useRef(new Map<string, number>()).current;
  // Remember where each row was, so going back reopens its selection, its
  // search, and (through `scroll`) its list position.
  const [lastRow, setLastRow] = useState<PaneRow>("inbox");
  const origin = useInboxConversationOrigin();
  const row = paneRowForPath(location, props.navItems, origin);
  const here = `${location.pathname}${location.search}`;
  const [rowPaths, setRowPaths] = useState<Partial<Record<PaneRow, string>>>(
    {},
  );
  // An old link redirects, so it is not a place to reopen.
  if (row && rowPaths[row] !== here && !isOldAutomationsPath(location))
    setRowPaths({ ...rowPaths, [row]: here });
  if (row && row !== lastRow) setLastRow(row);
  const [width, setWidth] = useState(readPaneWidth);
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
      currentMark: row ? paneRowMark(location.pathname) : undefined,
      currentRow: row,
      lastRow,
      navItems: props.navItems,
      onSearch: props.onSearch,
      open,
      profile: props.profile,
      rowPaths,
      scroll,
      setOpen,
      spend: props.spend,
      takeToggleFocus: () => {
        const take = focusToggle.current;
        focusToggle.current = false;
        return take;
      },
      workspaceActive: props.workspaceActive,
      zen,
    }),
    [
      lastRow,
      location.pathname,
      open,
      props.navItems,
      props.onSearch,
      props.profile,
      props.spend,
      props.workspaceActive,
      row,
      rowPaths,
      scroll,
      setOpen,
      zen,
    ],
  );
  const paneStyle: CSSProperties & Record<"--pane-width", string> = {
    "--pane-width": `${width}rem`,
  };
  const paneLinks = useMemo(
    () => ({ paneOpen: open, zen: zen.active }),
    [open, zen.active],
  );
  return (
    <PaneNavContext.Provider value={value}>
      <PaneWidthContext.Provider value={widthValue}>
        <PaneLinksContext value={paneLinks}>
          <div className="flex min-h-svh w-full" style={paneStyle}>
            {props.children}
          </div>
        </PaneLinksContext>
      </PaneWidthContext.Provider>
    </PaneNavContext.Provider>
  );
}

/** The way back to the row the reader came from, where it left off. */
export function usePaneBack(): { label: string; to: string } {
  const pane = usePaneNav();
  return {
    label: paneRowLabel(pane.lastRow, pane.navItems),
    to: pane.rowPaths[pane.lastRow] ?? paneRowRoot(pane.lastRow, pane.navItems),
  };
}

/**
 * Where a row's link goes, and how it marks the page that shows, if it owns
 * it. From another destination, a row reopens where the reader left it. A
 * row that owns the page goes back to its top level, and inside the Inbox
 * each view opens its list.
 */
export function usePaneRowLink(row: PaneRow): {
  mark?: PaneRowMark;
  to: string;
} {
  const pane = usePaneNav();
  const root = paneRowRoot(row, pane.navItems);
  const current = pane.currentRow === row;
  const sameInbox = isInboxView(row) && isInboxView(pane.currentRow);
  return {
    mark: current ? pane.currentMark : undefined,
    to: current || sameInbox ? root : (pane.rowPaths[row] ?? root),
  };
}

/** Read the pane's primary destinations, such as primary plugin pages. */
export function usePaneNavItems(): DashboardHeaderNavItem[] {
  return usePaneNav().navItems;
}

/**
 * Keep a page list's scroll position while the reader is on another row.
 * Spread the result on the element that scrolls; the offset comes back once
 * `ready` says its rows are there.
 */
export function usePaneRowScroll(key: string, ready: boolean) {
  const { scroll } = usePaneNav();
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ready && ref.current) ref.current.scrollTop = scroll.get(key) ?? 0;
  }, [key, ready, scroll]);
  return {
    onScroll: (event: { currentTarget: HTMLElement }) =>
      scroll.set(key, event.currentTarget.scrollTop),
    ref,
  };
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

/** What "New" does on the page that shows now. */
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
  else void navigate(action.to, { state: FOCUS_REPLY_STATE });
}

/** New where a page names nothing else, such as the Inbox and areas. */
const NEW_CONVERSATION_ACTION: PaneNewAction = {
  label: "New conversation",
  to: COMPOSER_PATH,
};

/** A square "+" in the pane header. Its name says what the page creates. */
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
      {/* Same height and rule as the page headers. The logo fills one
          control box, like the buttons, and starts at the list's inset;
          the toggle ends on the right content edge, 24px in, like row
          dates and counts. */}
      <div className="box-content flex h-header items-center gap-1.5 border-b border-b-dashboard-border pr-4 pl-3">
        <Link
          aria-label={`${name} home`}
          className={cn(
            toolbarControlBoxClass,
            "block shrink-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus/70",
          )}
          to={NAV_PAGES.inbox.to}
        >
          <JuniorLogo size="sm" />
        </Link>
        <PaneSearchBar />
        <NewButton action={props.newAction} />
        <PaneToggle open />
      </div>
    </div>
  );
}

/**
 * Open the command palette from a bar that fills the header row, with its
 * shortcut shown. A bar too narrow for "Search" and the chip drops the chip;
 * the tooltip still names the shortcut. The page header keeps the compact
 * `PaneSearch` while the pane is hidden.
 */
function PaneSearchBar() {
  const pane = usePaneNav();
  return (
    <button
      aria-keyshortcuts="Meta+K Control+K"
      className="@container flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-lg border border-dashboard-border bg-dashboard-control px-2.5 text-left font-sans text-sm text-dashboard-text-muted transition-colors hover:border-dashboard-border-interactive hover:text-dashboard-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus/70"
      onClick={pane.onSearch}
      title={`Search (${COMMAND_PALETTE_SHORTCUT})`}
      type="button"
    >
      <Search
        aria-hidden="true"
        className="size-4 shrink-0"
        strokeWidth={1.9}
      />
      <span className="min-w-0 flex-1 truncate">Search</span>
      <kbd className="shrink-0 whitespace-nowrap rounded @max-[7.5rem]:hidden border border-dashboard-border px-1.5 py-0.5 font-sans text-2xs text-dashboard-text-faint">
        {COMMAND_PALETTE_SHORTCUT}
      </kbd>
    </button>
  );
}

/**
 * Keep the pane list's scroll position across pages. Each page mounts its
 * own pane, so the offset is saved on scroll and put back once the list has
 * rows again.
 */
function usePaneScrollMemory(list: string | undefined) {
  const pane = usePaneNav();
  const ref = useRef<HTMLDivElement>(null);
  const { scroll } = pane;
  const key = list && `pane:${list}`;
  useLayoutEffect(() => {
    const saved = key ? scroll.get(key) : undefined;
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
  }, [key, scroll]);
  return {
    onScrollCapture: (event: { target: EventTarget }) => {
      if (key && event.target instanceof HTMLElement) {
        scroll.set(key, event.target.scrollTop);
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
    const remPx = rootFontPx();
    let next = startWidth;
    const move = (moveEvent: PointerEvent) => {
      const raw = startWidth + (moveEvent.clientX - startX) / remPx;
      if (raw < PANE_WIDTH.min / 2) {
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
      savePaneWidth(next * remPx);
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
    savePaneWidth(next * rootFontPx());
  };

  // The separator reports px, the unit that the reader sees move.
  const remPx = rootFontPx();

  return (
    <div
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      aria-valuemax={Math.round(PANE_WIDTH.max * remPx)}
      aria-valuemin={Math.round(PANE_WIDTH.min * remPx)}
      aria-valuenow={Math.round(width * remPx)}
      className="absolute inset-y-0 right-0 z-20 w-2 cursor-col-resize after:absolute after:inset-y-0 after:right-0 after:w-px after:transition-colors hover:after:bg-dashboard-border-interactive focus-visible:outline-none focus-visible:after:bg-dashboard-border-interactive max-md:hidden"
      onKeyDown={stepWidth}
      onPointerDown={startDrag}
      role="separator"
      tabIndex={0}
    />
  );
}

/**
 * Lay out one desktop pane: the header, then the list, such as the
 * destinations or an area's pages, then the profile. `scrollList` names a
 * list whose scroll position holds across pages. Phones show only the
 * list, under the app header. Children draw their own pane edge, like
 * `PANE_EDGE_CLASS`. On desktop the pane takes the shared width. `newAction`
 * names what New in the header creates; a new conversation by default.
 */
export function ListPane(props: {
  children?: ReactNode;
  className?: string;
  newAction?: PaneNewAction;
  scrollList?: string;
}) {
  const pane = usePaneNav();
  const scroll = usePaneScrollMemory(props.scrollList);
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
