import { useEffect, useRef, useState, type ReactNode } from "react";
import { Menu, PanelRight } from "lucide-react";

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
  TranscriptSearchToggle,
  type ConversationArchiveAction,
  type ConversationPinAction,
} from "./ConversationHeaderActions";
import { ConversationOverflowMenu } from "./ConversationOverflowMenu";
import { TranscriptSearchBar } from "./TranscriptSearchBar";
import type { TranscriptViewMode } from "./transcriptRenderModel";
import type { TranscriptSearchMatch } from "./transcriptSearch";

/**
 * Keep the conversation title and frequently used controls in the header.
 * Run facts and the Brief live in Conversation details.
 */
export function ConversationHeader(props: {
  /** Parent chain of a child Conversation. Root Conversations omit it. */
  agentTree?: ReactNode;
  contextTags?: ReactNode;
  /** A `menu` layout copy action for the `⋯` menu. */
  copyAction?: ReactNode;
  archive: ConversationArchiveAction;
  conversationId: string;
  /** Estimated cost. Desktop only; mobile shows it in Conversation details. */
  cost?: ReactNode;
  detailsOpen: boolean;
  onDetailsClick(): void;
  /** Links to the fork source and to forks of this conversation. */
  forks?: ReactNode;
  /** Linked work links in the tags row below the title on mobile. */
  linkedWork?: ReactNode;
  onSearchChange(value: string): void;
  onViewChange(value: TranscriptViewMode): void;
  pin: ConversationPinAction;
  privacy: ReactNode;
  search: string;
  searchMatch: TranscriptSearchMatch;
  sentryConversationUrl?: string;
  sidebarToggle?: ReactNode;
  title: string;
  view: TranscriptViewMode;
}) {
  const detailsOpen = props.detailsOpen;
  const detailsButtonRef = useRef<HTMLButtonElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const wasDetailsOpen = useRef(detailsOpen);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchOpenVisible =
    props.view === "rich" && (searchOpen || props.search.length > 0);
  const openMobileNavigation = useOpenMobileNavigation();

  useEffect(() => {
    if (
      wasDetailsOpen.current &&
      !detailsOpen &&
      document.activeElement === document.body
    ) {
      const trigger = window.matchMedia("(max-width: 767px)").matches
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

  const menuActions = (placement: "desktop" | "mobile", close: () => void) => (
    <ConversationHeaderActions
      archive={props.archive}
      conversationId={props.conversationId}
      pin={props.pin}
      copyAction={props.copyAction}
      detailsOpen={detailsOpen}
      onDetailsClick={() => {
        close();
        props.onDetailsClick();
      }}
      onSearchClick={() => {
        close();
        toggleSearch();
      }}
      onViewChange={(value) => {
        close();
        props.onViewChange(value);
      }}
      placement={placement}
      searchOpen={searchOpenVisible}
      sentryConversationUrl={props.sentryConversationUrl}
      view={props.view}
    />
  );

  const showMobileHeader =
    searchOpenVisible ||
    Boolean(props.archive.error) ||
    props.pin.error ||
    Boolean(props.forks) ||
    Boolean(props.agentTree);

  return (
    <>
      <MobileHeaderActionsPortal>
        <ConversationOverflowMenu buttonRef={menuButtonRef}>
          {(close) => (
            <>
              {menuActions("mobile", close)}
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
        className={cn(
          "relative z-10 border-b md:z-30 border-dashboard-border bg-dashboard-bg",
          !showMobileHeader && "hidden md:block",
        )}
      >
        <div className="hidden h-13 min-w-0 items-center justify-between gap-1.5 px-1 md:flex">
          <div className="flex min-w-0 items-center gap-1.5">
            {props.sidebarToggle ? (
              <div className="shrink-0">{props.sidebarToggle}</div>
            ) : null}
            {props.view === "raw" ? (
              // Event log is a debug view reached from the `⋯` menu. The
              // title leads back to the Conversation.
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
            )}
            {props.privacy ? (
              <span className="shrink-0">{props.privacy}</span>
            ) : null}
            {props.agentTree ? (
              <div className="min-w-0 max-w-1/3 shrink-[2] border-l border-dashboard-border-subtle pl-2 text-xs text-dashboard-text-muted [&_a]:text-dashboard-text-muted [&_a:hover]:text-dashboard-text">
                {props.agentTree}
              </div>
            ) : props.contextTags ? (
              <div className="flex h-6 min-w-0 max-w-[min(19rem,60%)] shrink-[2] items-center">
                {props.contextTags}
              </div>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {props.cost ? (
              <span className="mr-2 text-xs tabular-nums text-dashboard-text-muted">
                {props.cost}
              </span>
            ) : null}
            {props.view === "raw" ? null : (
              <TranscriptSearchToggle
                inputRef={searchInputRef}
                onClick={toggleSearch}
                open={searchOpenVisible}
              />
            )}
            <ConversationOverflowMenu>
              {(close) => menuActions("desktop", close)}
            </ConversationOverflowMenu>
            {detailsOpen ? null : (
              <HeaderIconButton
                ref={detailsButtonRef}
                expanded={false}
                label="Conversation details"
                onClick={props.onDetailsClick}
              >
                <PanelRight aria-hidden="true" size={15} strokeWidth={2} />
              </HeaderIconButton>
            )}
          </div>
        </div>
        {props.forks ? (
          <div className="hidden px-7 pb-2.5 md:block">{props.forks}</div>
        ) : null}
        {props.agentTree ? (
          <div className="px-4 py-2 md:hidden">{props.agentTree}</div>
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
        {props.archive.error ? (
          <div className="px-4 pb-3 text-xs text-red-300 md:px-7">
            {props.archive.error}
          </div>
        ) : null}
        {props.pin.error ? (
          <div className="px-4 pb-3 text-xs text-red-300 md:px-7">
            Could not update pin.
          </div>
        ) : null}
      </header>
    </>
  );
}
