import { useEffect, useRef, useState, type ReactNode } from "react";
import { Menu, PanelRight } from "lucide-react";
import type { ConversationAgentTreeNode } from "@sentry/junior/api/schema";

import { DropdownMenuItem } from "../components/ui/dropdown-menu";
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
} from "./ConversationHeaderActions";
import type { ConversationMenu } from "./conversationMenuItems";
import { ChildAgentTags } from "./ChildAgentTags";
import { ConversationBreadcrumb } from "./ConversationBreadcrumb";
import { ConversationOverflowMenu } from "./ConversationOverflowMenu";
import { TranscriptSearchBar } from "./TranscriptSearchBar";
import type { TranscriptViewMode } from "./transcriptRenderModel";
import type { TranscriptSearchMatch } from "./transcriptSearch";
import { MOBILE_LAYOUT_QUERY } from "../layoutMedia";

/**
 * Keep the conversation title and frequently used controls in the header.
 * Run facts and the Brief live in Conversation details.
 */
export function ConversationHeader(props: {
  /** Agent tree of a child Conversation. Root Conversations omit it. */
  agentTree?: readonly ConversationAgentTreeNode[] | undefined;
  contextTags?: ReactNode;
  /** Estimated cost. Desktop only; mobile shows it in Conversation details. */
  cost?: ReactNode | undefined;
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
  sidebarToggle?: ReactNode | undefined;
  /** Status pill of a child Conversation, after its title. */
  status?: ReactNode;
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

  const menuActions = (placement: "desktop" | "mobile") => (
    <ConversationHeaderActions
      // Desktop makes the whole control inert until the Conversation exists.
      // Mobile turns off only these rows, so the app menu row stays usable.
      disabled={placement === "mobile" && props.pending}
      menu={props.menu}
      onDetailsClick={props.onDetailsClick}
      onSearchClick={toggleSearch}
      placement={placement}
      searchOpen={searchOpenVisible}
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
      <h2
        aria-current="page"
        className="m-0 min-w-0 truncate font-display text-base font-medium leading-6 tracking-tight"
      >
        {props.title}
      </h2>
    );

  const childAgentTags = <ChildAgentTags node={props.agentTree?.at(-1)} />;

  const showMobileHeader =
    searchOpenVisible ||
    props.errors.length > 0 ||
    Boolean(props.forks) ||
    Boolean(props.agentTree);

  return (
    <>
      <MobileHeaderActionsPortal>
        <ConversationOverflowMenu buttonRef={menuButtonRef}>
          {menuActions("mobile")}
          {openMobileNavigation ? (
            <DropdownMenuItem onClick={openMobileNavigation}>
              <Menu aria-hidden="true" />
              App menu
            </DropdownMenuItem>
          ) : null}
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
            {props.agentTree ? (
              <ConversationBreadcrumb current={title} nodes={props.agentTree} />
            ) : (
              title
            )}
            {props.status}
            {childAgentTags}
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
          <div
            className="flex shrink-0 items-center gap-0.5"
            inert={props.pending}
          >
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
              {menuActions("desktop")}
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
