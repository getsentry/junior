import type { ReactNode } from "react";
import { Archive, ArchiveRestore } from "lucide-react";

import { Button } from "../components/Button";

/** Render the sticky conversation title, metadata, and actions. */
export function ConversationHeader(props: {
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
  privacy: ReactNode;
  stats: ReactNode;
  title: string;
}) {
  return (
    <header className="sticky top-0 z-10 -mx-3 mb-2 border-b border-white/[0.07] bg-[#050507]/92 px-3 pb-1.5 pt-3 backdrop-blur md:-mx-7 md:mb-4 md:px-7 md:pb-3 md:pt-5">
      <div className="flex min-w-0 items-center justify-between gap-2 md:items-start md:gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-x-2 gap-y-1">
            <h2 className="m-0 line-clamp-1 min-w-0 font-display text-sm font-medium leading-tight tracking-[-0.03em] md:text-2xl">
              {props.title}
            </h2>
            {props.live ? (
              <span
                aria-label="Conversation is live"
                className="inline-flex size-2 shrink-0 rounded-full bg-emerald-300 md:hidden"
                title="Live"
              />
            ) : null}
            <span className="hidden md:inline-flex">{props.privacy}</span>
          </div>
          <div className="mt-1 hidden min-w-0 font-sans text-xs leading-snug text-dashboard-text-muted md:block">
            {props.identity}
          </div>
        </div>
        <ArchiveConversationButton {...props.archive} />
      </div>
      {props.archive.error ? (
        <div className="mt-1.5 text-xs text-red-300/80">
          Could not update archive state.
        </div>
      ) : null}
      {props.stats}
      <div className="hidden md:block">{props.annotations}</div>
    </header>
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
      <Icon aria-hidden="true" size={16} strokeWidth={2} />
    </Button>
  );
}
