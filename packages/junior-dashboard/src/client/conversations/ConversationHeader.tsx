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
import {
  MobileHeaderActionsPortal,
  useOpenMobileNavigation,
} from "../components/layout/DashboardChrome";
import {
  ConversationHeaderActions,
  HeaderIconButton,
  type ConversationArchiveAction,
} from "./ConversationHeaderActions";
import { ConversationDetailsDrawer } from "./ConversationDetailsDrawer";
import type { TranscriptViewMode } from "./transcriptRenderModel";

/** Render the sticky conversation title, compact tools, and advanced details. */
export function ConversationHeader(props: {
  copyAction?: ReactNode;
  annotations: ReactNode;
  archive: ConversationArchiveAction;
  conversationId: string;
  identity: ReactNode;
  live: boolean;
  meta?: ReactNode;
  onSearchChange(value: string): void;
  onViewChange(value: TranscriptViewMode): void;
  privacy: ReactNode;
  search: string;
  stats: ReactNode;
  title: string;
  view: TranscriptViewMode;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const mobileMenuRef = useRef<HTMLDivElement>(null);
  const searchOpenVisible = searchOpen || props.search.length > 0;
  const openMobileNavigation = useOpenMobileNavigation();

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
        label={mobileMenuOpen ? "Close conversation menu" : "Conversation menu"}
        onClick={() => setMobileMenuOpen((open) => !open)}
        pressed={mobileMenuOpen}
      >
        <Ellipsis aria-hidden="true" size={18} strokeWidth={2} />
      </HeaderIconButton>
      {mobileMenuOpen ? (
        <div className="absolute right-0 top-[calc(100%+0.35rem)] z-40 w-56 rounded-xl border border-white/[0.08] bg-dashboard-surface-raised/95 p-1.5 shadow-2xl shadow-black/75 backdrop-blur-xl">
          <ConversationHeaderActions
            archive={props.archive}
            copyAction={menuCopyAction}
            detailsOpen={detailsOpen}
            layout="menu"
            onDetailsClick={() => {
              setMobileMenuOpen(false);
              setDetailsOpen(true);
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
              className="mt-0.5 flex w-full cursor-pointer items-center gap-2.5 rounded-md border-0 bg-transparent px-2.5 py-2 text-left text-sm font-semibold text-dashboard-text transition-colors hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline-none"
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

  const showMobileChrome = searchOpenVisible || props.archive.error;

  return (
    <>
      <MobileHeaderActionsPortal>{mobileOverflow}</MobileHeaderActionsPortal>
      <header
        className={
          showMobileChrome
            ? "sticky top-0 z-10 -mx-3 mb-2 border-b border-white/[0.07] bg-[#050507]/92 px-3 pb-2 pt-2 backdrop-blur md:-mx-7 md:mb-3 md:px-7 md:pb-2.5 md:pt-4"
            : "sticky top-0 z-10 -mx-3 mb-2 hidden border-b border-white/[0.07] bg-[#050507]/92 px-3 pb-2 pt-3 backdrop-blur md:-mx-7 md:mb-3 md:block md:px-7 md:pb-2.5 md:pt-4"
        }
      >
        <div className="hidden min-w-0 items-start justify-between gap-2 md:flex">
          <div className="min-w-0 pt-0.5">
            <div className="flex min-w-0 items-center gap-x-2 gap-y-1">
              <h2 className="m-0 line-clamp-1 min-w-0 font-display text-xl font-medium leading-tight tracking-[-0.03em]">
                {props.title}
              </h2>
              {props.live ? (
                <span
                  aria-label="Conversation is live"
                  className="inline-flex size-2 shrink-0 rounded-full bg-emerald-300"
                  title="Live"
                />
              ) : null}
              <span className="hidden shrink-0 sm:inline-flex">
                {props.privacy}
              </span>
            </div>
          </div>
          <ConversationHeaderActions
            archive={props.archive}
            copyAction={props.copyAction}
            detailsOpen={detailsOpen}
            onDetailsClick={() => setDetailsOpen(true)}
            onSearchClick={toggleSearch}
            onViewChange={props.onViewChange}
            searchOpen={searchOpenVisible}
            view={props.view}
          />
        </div>

        {searchOpenVisible ? (
          <div className="min-w-0 md:mt-2">
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
          <div className="mt-1.5 text-xs text-red-300/80">
            Could not update archive state.
          </div>
        ) : null}

        {props.meta ? (
          <div className="mt-1.5 hidden min-w-0 font-sans text-xs leading-snug text-dashboard-text-muted md:block">
            {props.meta}
          </div>
        ) : null}
      </header>

      {detailsOpen ? (
        <ConversationDetailsDrawer
          annotations={props.annotations}
          conversationId={props.conversationId}
          identity={props.identity}
          onClose={() => setDetailsOpen(false)}
          privacy={props.privacy}
          stats={props.stats}
          title={props.title}
        />
      ) : null}
    </>
  );
}
