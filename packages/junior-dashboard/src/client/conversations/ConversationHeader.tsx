import {
  cloneElement,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { Ellipsis, Menu } from "lucide-react";

import { SearchInput } from "../components/SearchInput";
import { cn } from "../styles";
import {
  MobileHeaderActionsPortal,
  MobileHeaderLivePortal,
  useOpenMobileNavigation,
} from "../components/layout/DashboardChrome";
import {
  ConversationHeaderActions,
  HeaderIconButton,
  TranscriptViewToggle,
  type ConversationArchiveAction,
} from "./ConversationHeaderActions";
import type { TranscriptViewMode } from "./transcriptRenderModel";

/** Show the conversation title, search, and details. */
export function ConversationHeader(props: {
  /** Parent chain of a child Conversation. Root Conversations omit it. */
  agentTree?: ReactNode;
  copyAction?: ReactNode;
  archive: ConversationArchiveAction;
  conversationId: string;
  detailsOpen: boolean;
  onDetailsClick(): void;
  /** Links to the fork source and to forks of this conversation. */
  forks?: ReactNode;
  linkedWork?: ReactNode;
  live: boolean;
  meta?: ReactNode;
  onSearchChange(value: string): void;
  onViewChange(value: TranscriptViewMode): void;
  privacy: ReactNode;
  search: string;
  title: string;
  view: TranscriptViewMode;
}) {
  const detailsOpen = props.detailsOpen;
  const detailsButtonRef = useRef<HTMLButtonElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const wasDetailsOpen = useRef(detailsOpen);
  const [searchOpen, setSearchOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const mobileMenuRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    if (!mobileMenuOpen) return;

    function closeOnOutsideClick(event: PointerEvent) {
      if (!mobileMenuRef.current?.contains(event.target as Node)) {
        setMobileMenuOpen(false);
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setMobileMenuOpen(false);
    }

    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [mobileMenuOpen]);

  const toggleSearch = () => {
    if (searchOpenVisible) {
      setSearchOpen(false);
      if (props.search.length > 0) props.onSearchChange("");
      return;
    }
    setSearchOpen(true);
  };

  const menuCopyAction =
    isValidElement(props.copyAction) &&
    typeof props.copyAction.type !== "string"
      ? cloneElement(
          props.copyAction as ReactElement<{ layout?: "icon" | "menu" }>,
          { layout: "menu" },
        )
      : props.copyAction;

  const mobileOverflow = (
    <div className="relative" ref={mobileMenuRef}>
      <HeaderIconButton
        ref={menuButtonRef}
        label={mobileMenuOpen ? "Close conversation menu" : "Conversation menu"}
        onClick={() => setMobileMenuOpen((open) => !open)}
        pressed={mobileMenuOpen}
      >
        <Ellipsis aria-hidden="true" size={18} strokeWidth={2} />
      </HeaderIconButton>
      {mobileMenuOpen ? (
        <div className="absolute right-0 top-[calc(100%+0.35rem)] z-40 w-56 rounded-xl border border-dashboard-border-strong bg-dashboard-surface-raised/95 p-1.5 shadow-2xl shadow-black/75 backdrop-blur-xl">
          <ConversationHeaderActions
            archive={props.archive}
            conversationId={props.conversationId}
            copyAction={menuCopyAction}
            detailsOpen={detailsOpen}
            layout="menu"
            onDetailsClick={() => {
              setMobileMenuOpen(false);
              props.onDetailsClick();
            }}
            onSearchClick={() => {
              setMobileMenuOpen(false);
              toggleSearch();
            }}
            onViewChange={(value) => {
              setMobileMenuOpen(false);
              props.onViewChange(value);
            }}
            searchOpen={searchOpenVisible}
            view={props.view}
          />
          {openMobileNavigation ? (
            <button
              className="mt-0.5 flex w-full cursor-pointer items-center gap-2.5 rounded-md border-0 bg-transparent px-2.5 py-2 text-left text-sm font-semibold text-dashboard-text transition-colors hover:bg-dashboard-fill-hover focus-visible:bg-dashboard-fill-hover focus-visible:outline-none"
              onClick={() => {
                setMobileMenuOpen(false);
                openMobileNavigation();
              }}
              type="button"
            >
              <Menu aria-hidden="true" size={16} strokeWidth={2} />
              App menu
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
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
      <MobileHeaderActionsPortal>{mobileOverflow}</MobileHeaderActionsPortal>
      <MobileHeaderLivePortal>{liveIndicator}</MobileHeaderLivePortal>
      <header
        className={cn(
          "relative z-10 border-b border-dashboard-border bg-dashboard-bg",
          !showMobileHeader && "hidden md:block",
        )}
      >
        <div className="hidden min-w-0 items-start justify-between gap-4 px-7 py-5 md:flex">
          <div className="min-w-0">
            {props.agentTree ? (
              <div className="mb-1.5 min-w-0">{props.agentTree}</div>
            ) : null}
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="m-0 line-clamp-1 min-w-0 font-display text-xl font-medium leading-tight tracking-tight">
                {props.title}
              </h2>
              {liveIndicator}
              <span className="shrink-0">{props.privacy}</span>
            </div>
            {props.meta ? (
              <div className="mt-2 min-w-0 text-xs leading-snug text-dashboard-text-muted">
                {props.meta}
              </div>
            ) : null}
            {props.forks ? (
              <div className="mt-1.5 min-w-0">{props.forks}</div>
            ) : null}
          </div>
          <ConversationHeaderActions
            archive={props.archive}
            conversationId={props.conversationId}
            copyAction={props.copyAction}
            detailsOpen={detailsOpen}
            detailsButtonRef={detailsButtonRef}
            onDetailsClick={props.onDetailsClick}
            onSearchClick={toggleSearch}
            onViewChange={props.onViewChange}
            searchOpen={searchOpenVisible}
            view={props.view}
          />
        </div>
        {props.agentTree ? (
          <div className="px-4 py-2 md:hidden">{props.agentTree}</div>
        ) : null}
        {props.forks ? (
          <div className="px-4 py-2 md:hidden">{props.forks}</div>
        ) : null}
        {props.linkedWork ? (
          <div
            aria-label="Linked work"
            className="border-t border-dashboard-border-subtle px-4 py-2.5 md:px-7"
          >
            {props.linkedWork}
          </div>
        ) : null}
        <div className="hidden border-t border-dashboard-border-subtle px-7 md:flex">
          <TranscriptViewToggle
            labelled
            onChange={props.onViewChange}
            value={props.view}
          />
        </div>
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
