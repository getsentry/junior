import { useEffect, useRef, useState, type ReactNode } from "react";
import { displayPlainText } from "../display-text/plainText";
import { Menu, PanelRight } from "lucide-react";
import type { ConversationAgentTreeNode } from "@sentry/junior/api/schema";

import { Button } from "../components/ui/button";
import { cn } from "../styles";
import {
  MobileHeaderActionsPortal,
  MobileHeaderTagsPortal,
  useOpenMobileNavigation,
} from "../components/layout/DashboardChrome";
import {
  ConversationHeaderActions,
  HeaderIconButton,
} from "./ConversationHeaderActions";
import type { ConversationMenu } from "./conversationMenuItems";
import { ConversationBreadcrumb } from "./ConversationBreadcrumb";
import {
  BriefOutcomeChip,
  briefOutcomeLabel,
  type ConversationBriefReport,
} from "./ConversationBrief";
import { ConversationOverflowMenu } from "./ConversationOverflowMenu";
import { TranscriptSearchBar } from "./TranscriptSearchBar";
import type { TranscriptViewMode } from "./transcriptRenderModel";
import {
  useTranscriptFindShortcut,
  type TranscriptSearchMatch,
} from "./transcriptSearch";
import { MOBILE_LAYOUT_QUERY } from "../layoutMedia";
import { isPlatformShortcut, platformShortcut } from "../keyboard";
import { useZenMode, ZEN_MODE_SHORTCUT } from "../components/layout/PaneNav";

const DETAILS_TOGGLE_SHORTCUT = platformShortcut("b", { alt: true });

const NO_ANCHOR = { current: null };

/**
 * Keep the conversation title and frequently used controls in the header.
 * Run facts and the Brief live in Conversation details.
 */
export function ConversationHeader(props: {
  /** Agent tree of a child Conversation. Root Conversations omit it. */
  agentTree?: readonly ConversationAgentTreeNode[];
  /** The current Brief. Its outcome and intent show under the title. */
  brief?: ConversationBriefReport;
  contextTags?: ReactNode;
  /** Estimated cost. Desktop only; mobile shows it in Conversation details. */
  cost?: ReactNode;
  detailsOpen: boolean;
  /** Messages of failed menu actions, shown below the title bar. */
  errors: readonly string[];
  onDetailsClick(): void;
  /** Links to the fork source and to forks of this conversation. */
  forks?: ReactNode;
  /** Linked work links in the tags row below the title on mobile. */
  linkedWork?: ReactNode;
  menu: ConversationMenu;
  /**
   * The Conversation is not created yet. Its actions stay inert until it
   * exists; the sidebar toggle still works.
   */
  pending?: boolean;
  onSearchChange(value: string): void;
  onViewChange(value: TranscriptViewMode): void;
  privacy: ReactNode;
  search: string;
  searchMatch: TranscriptSearchMatch;
  sidebarToggle?: ReactNode;
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
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchOpenVisible =
    props.view === "rich" && (searchOpen || props.search.length > 0);
  const openMobileNavigation = useOpenMobileNavigation();
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

  useEffect(() => {
    if (
      wasDetailsOpen.current &&
      !detailsOpen &&
      document.activeElement === document.body
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

  // Search lives in the `⋯` menu; ⌘F / Ctrl+F still opens it. The Event log
  // has its own search, so the shortcut stays with the browser there.
  useTranscriptFindShortcut({
    anchorRef: props.view === "raw" ? NO_ANCHOR : headerRef,
    inputRef: searchInputRef,
    onOpen: toggleSearch,
    open: searchOpenVisible,
  });

  const menuActions = (placement: "desktop" | "mobile", close: () => void) => (
    <ConversationHeaderActions
      close={close}
      detailsOpen={detailsOpen}
      menu={props.menu}
      onDetailsClick={props.onDetailsClick}
      onSearchClick={toggleSearch}
      placement={placement}
      searchOpen={searchOpenVisible}
      zen={
        placement === "desktop" && zen.available
          ? {
              active: zen.active,
              onToggle: zen.toggle,
              shortcut: ZEN_MODE_SHORTCUT,
            }
          : undefined
      }
    />
  );

  const title =
    props.view === "raw" ? (
      // Event log is a debug view reached from the `⋯` menu. The title leads
      // back to the Conversation.
      <>
        <h2 className="m-0 min-w-0 font-display text-base font-medium leading-6 tracking-tight">
          <button
            className="block max-w-full cursor-pointer truncate text-left text-dashboard-text-muted hover:text-dashboard-text hover:underline"
            onClick={() => props.onViewChange("rich")}
            title="Back to conversation"
            type="button"
          >
            {props.title}
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
      <h2 className="m-0 min-w-0 truncate font-display text-base font-medium leading-6 tracking-tight">
        {props.title}
      </h2>
    );

  const showMobileHeader =
    searchOpenVisible ||
    props.errors.length > 0 ||
    Boolean(props.forks) ||
    Boolean(props.agentTree) ||
    Boolean(props.brief);

  // One line from the Brief: where the work stands and what it is for. It
  // opens the Brief, which leads Conversation details.
  const brief =
    props.brief && props.view === "rich"
      ? {
          brief: props.brief,
          onOpen: openDetails,
        }
      : undefined;

  return (
    <>
      <MobileHeaderActionsPortal>
        <ConversationOverflowMenu buttonRef={menuButtonRef}>
          {(close) => (
            <>
              {/* App menu stays usable on mobile, like the sidebar toggle. */}
              <div className="contents" inert={props.pending}>
                {menuActions("mobile", close)}
              </div>
              {openMobileNavigation ? (
                <Button
                  className="mt-0.5"
                  onClick={() => {
                    close();
                    openMobileNavigation();
                  }}
                  size="menu"
                >
                  <Menu aria-hidden="true" size={16} strokeWidth={2} />
                  App menu
                </Button>
              ) : null}
            </>
          )}
        </ConversationOverflowMenu>
      </MobileHeaderActionsPortal>
      {props.contextTags || props.linkedWork ? (
        <MobileHeaderTagsPortal>
          {/* One row. Tags keep their width; the slot scrolls. */}
          <div className="flex w-max items-center gap-1.5 [&>*]:shrink-0">
            {props.contextTags}
            {props.linkedWork ? (
              <div aria-label="Linked work">{props.linkedWork}</div>
            ) : null}
          </div>
        </MobileHeaderTagsPortal>
      ) : null}
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
            The Brief line shares the header row, so the row keeps the
            height of the pane and details headers. */}
        <div className="hidden h-header min-w-0 items-center justify-between gap-2 pl-6 pr-4 md:flex">
          <div className="grid min-w-0 gap-0.5">
            <div className="flex min-w-0 items-center gap-2">
              {props.sidebarToggle ? (
                <div className="shrink-0 empty:hidden">
                  {props.sidebarToggle}
                </div>
              ) : null}
              {props.agentTree ? (
                <ConversationBreadcrumb
                  current={title}
                  nodes={props.agentTree}
                />
              ) : (
                title
              )}
              {props.status}
              {props.privacy ? (
                <span className="shrink-0">{props.privacy}</span>
              ) : null}
              {/* A child has no Location of its own. */}
              {!props.agentTree && props.contextTags ? (
                <div className="flex h-6 min-w-0 max-w-[min(19rem,60%)] shrink-[2] items-center">
                  {props.contextTags}
                </div>
              ) : null}
            </div>
            {brief ? <BriefLine {...brief} /> : null}
          </div>
          <div
            className="flex shrink-0 items-center gap-1"
            inert={props.pending}
          >
            {props.cost ? (
              <span className="mr-2 text-xs tabular-nums text-dashboard-text-muted">
                {props.cost}
              </span>
            ) : null}
            <ConversationOverflowMenu>
              {(close) => menuActions("desktop", close)}
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
        {brief ? (
          <div className="px-4 pb-2.5 pt-2 md:hidden">
            <BriefLine {...brief} />
          </div>
        ) : null}
        {props.forks ? (
          <div className="hidden px-7 pb-2.5 md:block">{props.forks}</div>
        ) : null}
        {props.agentTree ? (
          <div className="flex min-w-0 items-center justify-between gap-2 px-4 py-2 md:hidden">
            <ConversationBreadcrumb nodes={props.agentTree} />
            {props.status}
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

function BriefLine(props: { brief: ConversationBriefReport; onOpen(): void }) {
  const status = props.brief.content.outcome.status;
  const intent = displayPlainText(
    props.brief.content.intent,
    props.brief.mentions,
  );
  return (
    <button
      aria-label={`Brief: ${briefOutcomeLabel(status)}. ${intent} Open the Brief.`}
      className="group flex w-full min-w-0 cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left font-sans focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus"
      onClick={props.onOpen}
      type="button"
    >
      <BriefOutcomeChip className="shrink-0" status={status} />
      <span className="min-w-0 truncate text-xs text-dashboard-text-muted group-hover:text-dashboard-text">
        {intent}
      </span>
    </button>
  );
}
