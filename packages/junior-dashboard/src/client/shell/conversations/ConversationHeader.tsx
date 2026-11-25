import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { Ellipsis, Info, PanelRight, Search, X } from "lucide-react";
import type { ConversationAgentTreeNode } from "@sentry/junior/api/schema";

import { Button } from "../../components/ui/button";
import { cn } from "../../styles";
import {
  MobileHeaderActionsPortal,
  MobileHeaderTitlePortal,
} from "../../components/layout/DashboardChrome";
import {
  ConversationHeaderActions,
  HeaderIconButton,
} from "../../conversations/ConversationHeaderActions";
import {
  isConversationParticipant,
  useConversationMenuItems,
  type ConversationMenu,
} from "../../conversations/conversationMenuItems";
import {
  EditableConversationTitle,
  type ConversationTitleEdit,
} from "../../conversations/EditableConversationTitle";
import { ChildAgentTags } from "../../conversations/ChildAgentTags";
import { ConversationBreadcrumb } from "../../conversations/ConversationBreadcrumb";
import { useMenuSheet } from "../../conversations/useMenuSheet";
import {
  CONVERSATION_MENU_BUTTON_CLASS,
  ConversationOverflowMenu,
} from "../../conversations/ConversationOverflowMenu";
import { TranscriptSearchBar } from "../../conversations/TranscriptSearchBar";
import type { TranscriptViewMode } from "../../conversations/transcriptRenderModel";
import {
  useTranscriptFindShortcut,
  type TranscriptSearchMatch,
} from "../../conversations/transcriptSearch";
import { MOBILE_LAYOUT_QUERY } from "../../layoutMedia";
import { isPlatformShortcut, platformShortcut } from "../../keyboard";
import { useZenMode } from "../../components/layout/PaneNav";
import { fadeOverflowClass, fadeWhenOverflowing } from "../../textFade";
import { LeadHeader } from "../../lead/LeadHeader";

const DETAILS_TOGGLE_SHORTCUT = platformShortcut("b", { alt: true });

const NO_ANCHOR = { current: null };

// The sheet opens only after a tap on a phone, so the drawer loads with the
// first open instead of with the page.
const ConversationMenuSheet = lazy(() =>
  import("../../conversations/ConversationMenuSheet").then((module) => ({
    default: module.ConversationMenuSheet,
  })),
);

/**
 * Head a Conversation page: its Space's header on a Lead, an empty bar until
 * the page knows which it is, else the Conversation's own header.
 */
export function ConversationHeader(
  props: ComponentProps<typeof ConversationTitleHeader> & {
    /** Undefined until the page knows whether it shows a Lead. */
    lead: boolean | undefined;
    /** The Conversation's Space, which a Lead's header shows. */
    spaceId?: string | undefined;
  },
) {
  if (props.lead)
    return (
      <LeadHeader
        detailsOpen={props.detailsOpen}
        onDetailsClick={props.onDetailsClick}
        sidebarToggle={props.sidebarToggle}
        spaceId={props.spaceId}
      />
    );
  if (props.lead === undefined)
    return (
      <div
        aria-hidden="true"
        className="hidden h-13 border-b border-dashboard-border md:block"
      />
    );
  return <ConversationTitleHeader {...props} />;
}

/**
 * Keep the header to one row: the title and the controls people use most.
 * The summary, cost, repository, and location live in Conversation details.
 * A phone gets its own layout: the title and one menu button in the app
 * bar, and the menu as a bottom sheet.
 */
function ConversationTitleHeader(props: {
  /** Agent tree of a child Conversation. Root Conversations omit it. */
  agentTree?: readonly ConversationAgentTreeNode[] | undefined;
  detailsOpen: boolean;
  /** Messages of failed menu actions, shown below the title bar. */
  errors: readonly string[];
  onDetailsClick(): void;
  /** Links to the fork source and to forks of this conversation. */
  forks?: ReactNode;
  menu: ConversationMenu;
  /**
   * The Conversation is not created yet. Its actions stay inert until it
   * exists; the sidebar toggle still works.
   */
  pending?: boolean;
  onSearchChange(value: string): void;
  onViewChange(value: TranscriptViewMode): void;
  privacy: ReactNode;
  /** Renames the Conversation in place. Only participants get it. */
  rename?: ConversationTitleEdit | undefined;
  search: string;
  searchMatch: TranscriptSearchMatch;
  sidebarToggle?: ReactNode | undefined;
  /** A link to the Conversation's Space, after the title. */
  space?: ReactNode;
  /** The tree state or pin icon, before the title. */
  state?: ReactNode;
  /** Status pill of a child Conversation, after its title. */
  status?: ReactNode;
  title: string;
  view: TranscriptViewMode;
}) {
  const detailsOpen = props.detailsOpen;
  const detailsButtonRef = useRef<HTMLButtonElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const wasDetailsOpen = useRef(detailsOpen);
  const [searchOpen, setSearchOpen] = useState(false);
  const sheet = useMenuSheet();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchOpenVisible =
    props.view === "rich" && (searchOpen || props.search.length > 0);
  const zen = useZenMode();
  const { onDetailsClick } = props;
  // In Zen mode, showing details leaves it first.
  const openDetails = () => {
    if (zen.active) zen.toggle();
    if (!detailsOpen) onDetailsClick();
  };

  // Option/Alt+Cmd/Ctrl+B shows or hides details, like VS Code's secondary
  // side bar. In Zen mode it leaves Zen mode, back to details as they were.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isPlatformShortcut(event, "b", { alt: true }) || event.repeat) {
        return;
      }
      if (window.matchMedia(MOBILE_LAYOUT_QUERY).matches) return;
      event.preventDefault();
      if (zen.active) zen.toggle();
      else onDetailsClick();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onDetailsClick, zen]);

  // The element that last took focus. A layout switch can hide it with CSS,
  // and then focus also falls to the body, but details did not take it.
  const lastFocusRef = useRef<Element | null>(null);
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      lastFocusRef.current = event.target as Element;
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);

  // Details that close with focus inside them return it to their trigger.
  useEffect(() => {
    if (
      wasDetailsOpen.current &&
      !detailsOpen &&
      document.activeElement === document.body &&
      !lastFocusRef.current?.isConnected
    ) {
      const trigger = window.matchMedia(MOBILE_LAYOUT_QUERY).matches
        ? menuButtonRef.current
        : detailsButtonRef.current;
      trigger?.focus({ preventScroll: true });
    }
    wasDetailsOpen.current = detailsOpen;
  }, [detailsOpen]);

  useEffect(() => {
    if (!searchOpenVisible) return;
    searchInputRef.current?.focus();
  }, [searchOpenVisible]);

  const closeSearch = () => {
    setSearchOpen(false);
    if (props.search.length > 0) props.onSearchChange("");
  };

  const toggleSearch = () => {
    if (searchOpenVisible) {
      closeSearch();
      return;
    }
    setSearchOpen(true);
  };

  // ⌘F / Ctrl+F opens search too. The Event log has its own search, so the
  // shortcut stays with the browser there.
  useTranscriptFindShortcut({
    anchorRef: props.view === "raw" ? NO_ANCHOR : headerRef,
    inputRef: searchInputRef,
    onOpen: toggleSearch,
    open: searchOpenVisible,
  });

  const menuGroups = useConversationMenuItems(props.menu);
  // The phone has no room for search and details buttons, so its sheet
  // leads with them.
  const sheetGroups = [
    [
      ...(props.view === "rich"
        ? [
            {
              icon: searchOpenVisible ? X : Search,
              key: "search",
              label: searchOpenVisible ? "Hide search" : "Search transcript",
              onClick: toggleSearch,
            },
          ]
        : []),
      {
        icon: Info,
        key: "details",
        label: "Conversation details",
        onClick: props.onDetailsClick,
      },
    ],
    ...menuGroups,
  ].map((items) =>
    props.pending ? items.map((item) => ({ ...item, disabled: true })) : items,
  );

  const rename = isConversationParticipant(props.menu)
    ? props.rename
    : undefined;
  const titleText = (
    <span className={fadeOverflowClass} ref={fadeWhenOverflowing}>
      {props.title}
    </span>
  );
  const titleClass =
    "font-display text-base font-medium leading-6 tracking-tight";
  const title =
    props.view === "raw" && !rename?.editing ? (
      // Event log is a debug view reached from the `⋯` menu. The title leads
      // back to the Conversation.
      <>
        <h2 className="m-0 min-w-0 font-display text-base font-medium leading-6 tracking-tight">
          <button
            className="flex max-w-full cursor-pointer text-left text-dashboard-text-muted hover:text-dashboard-text hover:underline"
            onClick={() => props.onViewChange("rich")}
            title="Back to conversation"
            type="button"
          >
            {titleText}
          </button>
        </h2>
        <span aria-hidden="true" className="text-dashboard-text-faint">
          ›
        </span>
        <span
          aria-current="page"
          className="shrink-0 font-display text-base font-medium leading-6 tracking-tight"
        >
          Event log
        </span>
      </>
    ) : (
      <h2
        aria-current="page"
        className={cn(
          "m-0 flex min-w-0",
          titleClass,
          rename?.editing && "min-w-1/2 flex-1",
        )}
      >
        {rename ? (
          <EditableConversationTitle
            {...rename}
            className={titleClass}
            title={props.title}
          >
            {titleText}
          </EditableConversationTitle>
        ) : (
          titleText
        )}
      </h2>
    );

  const childAgentTags = <ChildAgentTags node={props.agentTree?.at(-1)} />;

  const showMobileHeader =
    searchOpenVisible ||
    props.errors.length > 0 ||
    Boolean(props.forks) ||
    Boolean(props.agentTree);

  // A long title fades before the `⋯` button instead of running under it.
  const mobileTitle = (
    <span
      className={cn(MOBILE_TITLE_CLASS, fadeOverflowClass)}
      ref={fadeWhenOverflowing}
    >
      {titleText}
    </span>
  );

  return (
    <>
      <MobileHeaderTitlePortal>
        {props.state}
        {props.view === "raw" && !rename?.editing ? (
          // Back leads to the conversation here, so the title is plain text.
          <h1 className="m-0 flex min-w-0 flex-1 items-center gap-1.5">
            <span
              className={cn(
                MOBILE_TITLE_CLASS,
                fadeOverflowClass,
                "text-dashboard-text-muted",
              )}
              ref={fadeWhenOverflowing}
            >
              {titleText}
            </span>
            <span aria-hidden="true" className="text-dashboard-text-faint">
              ›
            </span>
            <span
              className={cn(MOBILE_TITLE_CLASS, "shrink-0 text-dashboard-text")}
            >
              Event log
            </span>
          </h1>
        ) : (
          <h1 className="m-0 flex min-w-0 flex-1 text-dashboard-text">
            {rename ? (
              <EditableConversationTitle
                {...rename}
                className={MOBILE_TITLE_CLASS}
                title={props.title}
              >
                {mobileTitle}
              </EditableConversationTitle>
            ) : (
              mobileTitle
            )}
          </h1>
        )}
      </MobileHeaderTitlePortal>
      <MobileHeaderActionsPortal>
        <Button
          aria-expanded={sheet.open}
          aria-haspopup="dialog"
          aria-label="Conversation menu"
          className={cn(CONVERSATION_MENU_BUTTON_CLASS, "size-10 rounded-lg")}
          onClick={sheet.show}
          ref={menuButtonRef}
          size="icon"
          variant="ghost"
        >
          <Ellipsis aria-hidden="true" size={20} strokeWidth={2} />
        </Button>
        {sheet.open ? (
          <Suspense fallback={null}>
            <ConversationMenuSheet
              groups={sheetGroups}
              onClose={sheet.close}
              title={props.title}
            />
          </Suspense>
        ) : null}
      </MobileHeaderActionsPortal>
      {/* Desktop: above the event log's sticky toolbar, so the `⋯` menu
          covers it. Mobile: below the app header, which holds the menu. */}
      <header
        ref={headerRef}
        className={cn(
          "relative z-10 border-b md:z-30 border-dashboard-border bg-dashboard-bg",
          !showMobileHeader && "hidden md:block",
        )}
      >
        {/* The title starts 24px in, the inset of the pane's icons. The last
            button's icon ends 24px from the edge, like the details close.
            One row, the height of the pane and details headers. */}
        <div className="hidden h-header min-w-0 items-center justify-between gap-2 pl-6 pr-4 md:flex">
          {/* The title field takes the free width. */}
          <div
            className={cn(
              "flex min-w-0 items-center gap-2",
              rename?.editing && "flex-1",
            )}
          >
            {props.sidebarToggle ? (
              <div className="shrink-0 empty:hidden">{props.sidebarToggle}</div>
            ) : null}
            {props.state}
            {props.agentTree ? (
              <ConversationBreadcrumb current={title} nodes={props.agentTree} />
            ) : (
              title
            )}
            {props.status}
            {childAgentTags}
            {props.space}
            {props.privacy ? (
              <span className="shrink-0">{props.privacy}</span>
            ) : null}
          </div>
          <div
            className="flex shrink-0 items-center gap-1"
            inert={props.pending}
          >
            {props.view === "rich" ? (
              <HeaderIconButton
                keyShortcuts={
                  searchOpenVisible ? undefined : "Meta+F Control+F"
                }
                label={searchOpenVisible ? "Hide search" : "Search transcript"}
                onClick={toggleSearch}
                pressed={searchOpenVisible}
                shortcut={searchOpenVisible ? undefined : platformShortcut("f")}
              >
                {searchOpenVisible ? (
                  <X aria-hidden="true" size={16} strokeWidth={1.9} />
                ) : (
                  <Search aria-hidden="true" size={16} strokeWidth={1.9} />
                )}
              </HeaderIconButton>
            ) : null}
            <ConversationOverflowMenu>
              <ConversationHeaderActions
                menu={props.menu}
                onDetailsClick={props.onDetailsClick}
                onSearchClick={toggleSearch}
                placement="desktop"
                searchOpen={searchOpenVisible}
              />
            </ConversationOverflowMenu>
            {detailsOpen ? null : (
              <HeaderIconButton
                ref={detailsButtonRef}
                expanded={false}
                keyShortcuts="Meta+Alt+B Control+Alt+B"
                label="Conversation details"
                onClick={openDetails}
                shortcut={DETAILS_TOGGLE_SHORTCUT}
              >
                <PanelRight aria-hidden="true" size={16} strokeWidth={1.9} />
              </HeaderIconButton>
            )}
          </div>
        </div>
        {props.forks ? (
          <div className="hidden px-7 pb-2.5 md:block">{props.forks}</div>
        ) : null}
        {props.agentTree ? (
          <div className="flex min-w-0 items-center justify-between gap-2 px-4 py-2 md:hidden">
            <ConversationBreadcrumb nodes={props.agentTree} />
            <div className="flex shrink-0 items-center gap-1.5">
              {props.status}
              {childAgentTags}
            </div>
          </div>
        ) : null}
        {props.forks ? (
          <div className="px-4 py-2 md:hidden">{props.forks}</div>
        ) : null}
        {searchOpenVisible ? (
          <TranscriptSearchBar
            className="inset-x-3 md:left-auto md:right-4 md:w-[max(20rem,25vw)]"
            inputRef={searchInputRef}
            match={props.searchMatch}
            onChange={props.onSearchChange}
            onClose={closeSearch}
            value={props.search}
          />
        ) : null}
        {props.errors.map((error) => (
          <div className="px-4 pb-3 text-xs text-red-300 md:px-7" key={error}>
            {error}
          </div>
        ))}
      </header>
    </>
  );
}

const MOBILE_TITLE_CLASS = "font-display text-base font-medium";
