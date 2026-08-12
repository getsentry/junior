import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Archive,
  ArchiveRestore,
  Info,
  MessagesSquare,
  ScrollText,
  Search,
  X,
} from "lucide-react";

import { Button, ToggleButton } from "../components/Button";
import { Drawer } from "../components/Drawer";
import { SearchInput } from "../components/SearchInput";
import { cn } from "../styles";
import type { TranscriptViewMode } from "./transcriptRenderModel";

/** Render the sticky conversation title, compact tools, and advanced details. */
export function ConversationHeader(props: {
  actions?: ReactNode;
  annotations: ReactNode;
  archive: {
    archived: boolean;
    disabled: boolean;
    error: boolean;
    onClick(): void;
    pending: boolean;
  };
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
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="min-w-0 pt-0.5">
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
          <div className="flex shrink-0 items-center gap-0.5">
            <HeaderIconButton
              label={searchOpenVisible ? "Hide search" : "Search transcript"}
              onClick={() => {
                if (searchOpenVisible) {
                  setSearchOpen(false);
                  if (props.search.length > 0) props.onSearchChange("");
                  return;
                }
                setSearchOpen(true);
              }}
              pressed={searchOpenVisible}
            >
              {searchOpenVisible ? (
                <X aria-hidden="true" size={15} strokeWidth={2} />
              ) : (
                <Search aria-hidden="true" size={15} strokeWidth={2} />
              )}
            </HeaderIconButton>
            <TranscriptViewToggle
              onChange={props.onViewChange}
              value={props.view}
            />
            {props.actions}
            <ArchiveConversationButton {...props.archive} />
            <HeaderIconButton
              label="Conversation details"
              onClick={() => setDetailsOpen(true)}
              pressed={detailsOpen}
            >
              <Info aria-hidden="true" size={15} strokeWidth={2} />
            </HeaderIconButton>
          </div>
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

function ConversationDetailsDrawer(props: {
  annotations: ReactNode;
  identity: ReactNode;
  onClose(): void;
  privacy: ReactNode;
  stats: ReactNode;
  title: string;
}) {
  const titleId = "conversation-details-drawer-title";
  return (
    <Drawer
      closeLabel="Close conversation details"
      dismissLabel="Dismiss conversation details"
      header={
        <>
          <h2
            className="m-0 min-w-0 break-words text-lg font-bold leading-tight text-dashboard-text"
            id={titleId}
          >
            {props.title}
          </h2>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {props.privacy}
          </div>
        </>
      }
      onClose={props.onClose}
      openKey={props.title}
      titleId={titleId}
    >
      <div className="grid min-w-0 gap-5">
        {props.identity ? (
          <DetailsSection title="Identity">
            <div className="min-w-0 break-words font-sans text-sm leading-relaxed text-dashboard-text-muted">
              {props.identity}
            </div>
          </DetailsSection>
        ) : null}
        {props.stats ? (
          <DetailsSection title="Runtime">
            <div className="min-w-0 break-words font-sans text-sm leading-relaxed text-dashboard-text-muted">
              {props.stats}
            </div>
          </DetailsSection>
        ) : null}
        {props.annotations ? (
          <DetailsSection title="Links">
            <div className="min-w-0">{props.annotations}</div>
          </DetailsSection>
        ) : null}
      </div>
    </Drawer>
  );
}

function DetailsSection(props: { children: ReactNode; title: string }) {
  return (
    <section className="grid min-w-0 gap-2">
      <h3 className="m-0 font-mono text-2xs font-medium uppercase tracking-[0.14em] text-dashboard-text-muted">
        {props.title}
      </h3>
      {props.children}
    </section>
  );
}

function TranscriptViewToggle(props: {
  onChange(value: TranscriptViewMode): void;
  value: TranscriptViewMode;
}) {
  return (
    <div
      aria-label="Transcript view"
      className="inline-flex items-center gap-0.5 rounded-md border border-white/[0.08] bg-black/20 p-0.5"
      role="group"
    >
      <ViewModeButton
        active={props.value === "rich"}
        label="Conversation"
        onClick={() => props.onChange("rich")}
      >
        <MessagesSquare aria-hidden="true" size={14} strokeWidth={2} />
      </ViewModeButton>
      <ViewModeButton
        active={props.value === "raw"}
        label="Event log"
        onClick={() => props.onChange("raw")}
      >
        <ScrollText aria-hidden="true" size={14} strokeWidth={2} />
      </ViewModeButton>
    </div>
  );
}

function ViewModeButton(props: {
  active: boolean;
  children: ReactNode;
  label: string;
  onClick(): void;
}) {
  return (
    <ToggleButton
      aria-label={props.label}
      className={cn(
        "!normal-case !no-underline grid size-7 place-items-center rounded px-0 py-0",
        props.active
          ? "bg-white/[0.08] text-dashboard-text"
          : "text-dashboard-text-muted",
      )}
      onClick={props.onClick}
      pressed={props.active}
      title={props.label}
      variant="text"
    >
      {props.children}
    </ToggleButton>
  );
}

function HeaderIconButton(props: {
  children: ReactNode;
  label: string;
  onClick(): void;
  pressed?: boolean;
}) {
  return (
    <Button
      aria-label={props.label}
      aria-pressed={props.pressed}
      className={cn(
        "text-dashboard-text-muted",
        props.pressed && "bg-white/10 text-dashboard-text",
      )}
      onClick={props.onClick}
      size="icon"
      title={props.label}
      type="button"
    >
      {props.children}
    </Button>
  );
}

function ArchiveConversationButton(props: {
  archived: boolean;
  disabled: boolean;
  onClick(): void;
  pending: boolean;
}) {
  const label = props.pending
    ? "Saving archive state"
    : props.archived
      ? "Unarchive"
      : "Archive";
  const Icon = props.archived ? ArchiveRestore : Archive;
  return (
    <Button
      aria-label={label}
      className="hidden shrink-0 text-dashboard-text-muted md:grid"
      disabled={props.disabled}
      onClick={props.onClick}
      size="icon"
      title={label}
      type="button"
    >
      <Icon aria-hidden="true" size={15} strokeWidth={2} />
    </Button>
  );
}
