import { useEffect, useRef, useState, type ReactNode } from "react";
import { Menu, PanelRight, ScrollText, X } from "lucide-react";

import { SearchInput } from "../components/SearchInput";
import { Button } from "../components/ui/button";
import { cn } from "../styles";
import {
  MobileHeaderActionsPortal,
  MobileHeaderLivePortal,
  useOpenMobileNavigation,
} from "../components/layout/DashboardChrome";
import {
  ConversationHeaderActions,
  HeaderIconButton,
  TranscriptSearchToggle,
  type ConversationArchiveAction,
} from "./ConversationHeaderActions";
import { ConversationOverflowMenu } from "./ConversationOverflowMenu";
import { ShareConversationButton } from "./ShareConversationButton";
import type { TranscriptViewMode } from "./transcriptRenderModel";

/**
 * Show the conversation title bar: where it runs, the title, and actions.
 * Run facts, linked work, and the Brief live in Conversation details.
 */
export function ConversationHeader(props: {
  /** Parent chain of a child Conversation. Root Conversations omit it. */
  agentTree?: ReactNode;
  /** A `menu` layout copy action for the `⋯` menu. */
  copyAction?: ReactNode;
  archive: ConversationArchiveAction;
  conversationId: string;
  detailsOpen: boolean;
  onDetailsClick(): void;
  /** Links to the fork source and to forks of this conversation. */
  forks?: ReactNode;
  /** Mobile only. Desktop shows linked work in Conversation details. */
  linkedWork?: ReactNode;
  live: boolean;
  /** Where the conversation runs, such as a Slack channel. */
  location?: ReactNode;
  onSearchChange(value: string): void;
  onViewChange(value: TranscriptViewMode): void;
  privacy: ReactNode;
  search: string;
  sentryConversationUrl?: string;
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

  const toggleSearch = () => {
    if (searchOpenVisible) {
      setSearchOpen(false);
      if (props.search.length > 0) props.onSearchChange("");
      return;
    }
    setSearchOpen(true);
  };

  const menuActions = (placement: "desktop" | "mobile", close: () => void) => (
    <ConversationHeaderActions
      archive={props.archive}
      conversationId={props.conversationId}
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
    props.archive.error ||
    Boolean(props.linkedWork) ||
    Boolean(props.forks) ||
    Boolean(props.agentTree);

  const liveIndicator = props.live ? (
    <span
      aria-label="Conversation is live"
      className="inline-flex size-2 shrink-0 rounded-full bg-emerald-300"
      title="Live"
    />
  ) : null;

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
      <MobileHeaderLivePortal>{liveIndicator}</MobileHeaderLivePortal>
      {/* Desktop: above the event log's sticky toolbar, so the `⋯` menu
          covers it. Mobile: below the app header, which holds the menu. */}
      <header
        className={cn(
          "relative z-10 border-b md:z-30 border-dashboard-border bg-dashboard-bg",
          !showMobileHeader && "hidden md:block",
        )}
      >
        <div className="hidden h-12 min-w-0 items-center justify-between gap-4 pl-7 pr-4 md:flex">
          <div className="flex min-w-0 items-center gap-2">
            {props.agentTree ? (
              <div className="min-w-0 shrink-[2]">{props.agentTree}</div>
            ) : props.location ? (
              <span className="shrink-0 text-sm text-dashboard-text-muted">
                {props.location}
              </span>
            ) : null}
            {props.agentTree || props.location ? (
              <span aria-hidden="true" className="text-dashboard-text-faint">
                ›
              </span>
            ) : null}
            <h2 className="m-0 line-clamp-1 min-w-0 font-display text-base font-medium leading-tight tracking-tight">
              {props.title}
            </h2>
            {liveIndicator}
            <span className="shrink-0">{props.privacy}</span>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {props.view === "raw" ? (
              // Event log is a debug view reached from the menu. Say which
              // view this is, and give one click back.
              <Button
                aria-label="Close event log"
                className="mr-1 h-8 px-2.5"
                onClick={() => props.onViewChange("rich")}
                variant="quiet"
              >
                <ScrollText aria-hidden="true" size={14} strokeWidth={2} />
                Event log
                <X aria-hidden="true" size={14} strokeWidth={2} />
              </Button>
            ) : (
              <TranscriptSearchToggle
                onClick={toggleSearch}
                open={searchOpenVisible}
              />
            )}
            <ShareConversationButton
              key={props.conversationId}
              conversationId={props.conversationId}
              layout="icon"
            />
            <ConversationOverflowMenu>
              {(close) => menuActions("desktop", close)}
            </ConversationOverflowMenu>
            <HeaderIconButton
              ref={detailsButtonRef}
              label="Conversation details"
              onClick={props.onDetailsClick}
              pressed={detailsOpen}
            >
              <PanelRight aria-hidden="true" size={15} strokeWidth={2} />
            </HeaderIconButton>
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
        {props.linkedWork ? (
          <div
            aria-label="Linked work"
            className="border-t border-dashboard-border-subtle px-4 py-2.5 md:hidden"
          >
            {props.linkedWork}
          </div>
        ) : null}
        {searchOpenVisible ? (
          <div className="px-4 py-3 md:px-7">
            <SearchInput
              className="min-w-0"
              inputRef={searchInputRef}
              label="Search transcript"
              onChange={props.onSearchChange}
              placeholder="Search transcript…"
              size="compact"
              value={props.search}
            />
          </div>
        ) : null}
        {props.archive.error ? (
          <div className="px-4 pb-3 text-xs text-red-300 md:px-7">
            Could not update archive state.
          </div>
        ) : null}
      </header>
    </>
  );
}
