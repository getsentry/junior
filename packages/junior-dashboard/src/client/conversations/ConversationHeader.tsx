import { useEffect, useRef, useState, type ReactNode } from "react";

import { SearchInput } from "../components/SearchInput";
import {
  ConversationHeaderActions,
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
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchOpenVisible = searchOpen || props.search.length > 0;

  useEffect(() => {
    if (!searchOpenVisible) return;
    searchInputRef.current?.focus();
  }, [searchOpenVisible]);

  return (
    <>
      <header className="sticky top-0 z-10 -mx-3 mb-2 border-b border-white/[0.07] bg-[#050507]/92 px-3 pb-2 pt-3 backdrop-blur md:-mx-7 md:mb-3 md:px-7 md:pb-2.5 md:pt-4">
        <div className="flex min-w-0 items-center justify-between gap-2 md:items-start">
          <div className="min-w-0 md:pt-0.5">
            <div className="flex min-w-0 items-center gap-x-2 gap-y-1">
              <h2 className="m-0 line-clamp-1 min-w-0 font-display text-sm font-medium leading-tight tracking-[-0.03em] md:text-xl">
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
            onSearchClick={() => {
              if (searchOpenVisible) {
                setSearchOpen(false);
                if (props.search.length > 0) props.onSearchChange("");
                return;
              }
              setSearchOpen(true);
            }}
            onViewChange={props.onViewChange}
            searchOpen={searchOpenVisible}
            view={props.view}
          />
        </div>

        {searchOpenVisible ? (
          <div className="mt-2 min-w-0">
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
