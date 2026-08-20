import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  Check,
  CircleAlert,
  ListFilter,
  LockKeyhole,
  SquarePen,
} from "lucide-react";
import { Link } from "react-router";

import { useArchiveConversation } from "./queries";
import {
  conversationDisplayTitle,
  conversationPath,
  slackLocationLabel,
  visualStatusForConversation,
} from "../format";
import { cn } from "../styles";
import type { Conversation, VisualStatus } from "../types";
import { ActiveIndicator } from "../components/ActiveIndicator";
import { Notice, NoticeAction } from "../components/Notice";
import { AnimatedList } from "./AnimatedList";
import {
  buildConversationSections,
  type ConversationSection,
} from "./conversationSections";
import { EmptyTelemetry } from "../components/EmptyTelemetry";
import { SearchInput } from "../components/SearchInput";
import { ConversationSidebarAnnotations } from "./ConversationMeta";

type ConversationSidebarEntry =
  | { first: boolean; key: string; kind: "section"; label: string }
  | { conversation: Conversation; key: string; kind: "conversation" };

const conversationEntryKey = (entry: ConversationSidebarEntry) => entry.key;

/** Render the compact personal conversation picker used by the home workspace. */
export function ConversationSidebar(props: {
  conversations: Conversation[];
  error?: string;
  loading: boolean;
  query: string;
  selectedId?: string;
  timeZone: string;
  status: "active" | "archived";
  /**
   * `panel` = split-pane dock with internal scroll.
   * `landing` = flow nav under create compose (parent owns scroll).
   */
  variant?: "panel" | "landing";
  onNewConversation(): void;
  onQueryChange(value: string): void;
  onStatusChange(value: "active" | "archived"): void;
}) {
  const variant = props.variant ?? "panel";
  const isLanding = variant === "landing";
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);
  const [archivedConversation, setArchivedConversation] =
    useState<Conversation>();
  const [archiveError, setArchiveError] = useState<Conversation>();
  const dismissArchivedConversation = useCallback(
    () => setArchivedConversation(undefined),
    [],
  );
  const handleArchiveError = useCallback((conversation: Conversation) => {
    setArchiveError(conversation);
  }, []);
  const handleArchived = useCallback((conversation: Conversation) => {
    setArchiveError((current) =>
      current?.id === conversation.id ? undefined : current,
    );
    setArchivedConversation(conversation);
  }, []);
  useEffect(() => {
    if (!filterOpen) return;
    function closeFilter(event: PointerEvent) {
      if (!filterRef.current?.contains(event.target as Node)) {
        setFilterOpen(false);
      }
    }
    function closeFilterOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setFilterOpen(false);
    }
    document.addEventListener("pointerdown", closeFilter);
    document.addEventListener("keydown", closeFilterOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeFilter);
      document.removeEventListener("keydown", closeFilterOnEscape);
    };
  }, [filterOpen]);
  // Rebuild section rows only when the feed or timezone changes. Avoid fresh
  // Date.now() arrays on unrelated parent renders while the reader is scrolling.
  const entries = useMemo(
    () =>
      conversationSidebarEntries(
        buildConversationSections(props.conversations, {
          nowMs: Date.now(),
          timeZone: props.timeZone,
        }),
      ),
    [props.conversations, props.timeZone],
  );
  return (
    <aside
      className={cn(
        "relative min-w-0",
        isLanding
          ? "border-t border-white/[0.07] bg-transparent"
          : "grid h-full min-h-0 grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden border-r border-white/[0.07] bg-white/[0.02]",
      )}
    >
      <div className={cn("px-3 pb-2", isLanding ? "pt-5" : "pt-3")} ref={filterRef}>
        <div className="flex items-center justify-between gap-2">
          <h2
            className={cn(
              "m-0 font-display font-medium leading-tight text-dashboard-text",
              isLanding ? "text-base" : "text-lg",
            )}
          >
            {isLanding ? "Your conversations" : "Conversations"}
          </h2>
          <div className="flex items-center gap-0.5">
            <button
              aria-controls="conversation-status-filter"
              aria-expanded={filterOpen}
              aria-haspopup="menu"
              aria-label="Filter conversations"
              className={cn(
                "grid size-7 cursor-pointer place-items-center rounded-md text-dashboard-text-muted transition hover:bg-white/[0.05] hover:text-dashboard-text focus:outline-none focus:ring-2 focus:ring-cyan-300/35",
                (filterOpen || props.status === "archived") &&
                  "bg-white/[0.06] text-dashboard-text",
              )}
              onClick={() => setFilterOpen((open) => !open)}
              title="Filter conversations"
              type="button"
            >
              <ListFilter aria-hidden="true" size={15} />
            </button>
            {isLanding ? null : (
              <button
                aria-label="New conversation"
                className="grid size-7 cursor-pointer place-items-center rounded-md text-dashboard-text-muted transition hover:bg-white/[0.05] hover:text-dashboard-text focus:outline-none focus:ring-2 focus:ring-cyan-300/35"
                onClick={props.onNewConversation}
                title="New conversation"
                type="button"
              >
                <SquarePen aria-hidden="true" size={15} />
              </button>
            )}
          </div>
        </div>
        {filterOpen ? (
          <div
            className="mt-2 rounded-lg bg-dashboard-surface-raised/95 p-1 shadow-2xl shadow-black/75 backdrop-blur-xl"
            id="conversation-status-filter"
            role="menu"
          >
            {(["active", "archived"] as const).map((status) => (
              <button
                aria-checked={props.status === status}
                className="flex w-full cursor-pointer items-center justify-between rounded-md px-2.5 py-2 text-left text-sm capitalize text-dashboard-text transition hover:bg-white/10 focus:bg-white/10 focus:outline-none"
                key={status}
                onClick={() => {
                  props.onStatusChange(status);
                  setFilterOpen(false);
                }}
                role="menuitemradio"
                type="button"
              >
                {status}
                {props.status === status ? (
                  <Check aria-hidden="true" size={14} />
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="px-2 pb-2">
        <SearchInput
          label="Search your conversations"
          onChange={props.onQueryChange}
          placeholder="Search conversations…"
          size="compact"
          value={props.query}
        />
      </div>
      <div
        className={cn(
          "px-1.5",
          isLanding
            ? "pb-[max(1rem,env(safe-area-inset-bottom))]"
            : "min-h-0 overflow-y-auto overscroll-contain pb-[max(0.5rem,env(safe-area-inset-bottom))]",
        )}
      >
        {props.error ? (
          <div className="p-2">
            <EmptyTelemetry>{props.error}</EmptyTelemetry>
          </div>
        ) : (
          <AnimatedList
            ariaLabel="Your conversations"
            className="grid gap-0.5"
            empty={
              !props.loading ? (
                <div className="p-2">
                  <EmptyTelemetry>
                    No conversations match this view.
                  </EmptyTelemetry>
                </div>
              ) : undefined
            }
            getKey={conversationEntryKey}
            items={entries}
            renderItem={(entry) =>
              entry.kind === "section" ? (
                <h3
                  className={cn(
                    "m-0 px-2.5 pb-0.5 font-display text-2xs font-semibold uppercase tracking-[0.08em] text-dashboard-text-muted/55",
                    entry.first ? "pt-1.5" : "pt-4",
                  )}
                >
                  {entry.label}
                </h3>
              ) : (
                <ConversationSidebarRow
                  conversation={entry.conversation}
                  onArchiveError={handleArchiveError}
                  onArchived={handleArchived}
                  selected={entry.conversation.id === props.selectedId}
                />
              )
            }
            role="navigation"
          />
        )}
      </div>
      {archivedConversation || archiveError ? (
        <div className="absolute bottom-[max(0.75rem,env(safe-area-inset-bottom))] left-3 right-3 z-20 grid gap-2">
          {archiveError ? (
            <ArchiveConversationErrorNotice
              conversation={archiveError}
              onDismiss={() => setArchiveError(undefined)}
            />
          ) : null}
          {archivedConversation ? (
            <ArchivedConversationNotice
              // Remount on each archive so the expiry timer and restore mutation reset.
              key={archivedConversation.id}
              conversation={archivedConversation}
              onRestored={dismissArchivedConversation}
            />
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}

function conversationSidebarEntries(
  sections: ConversationSection[],
): ConversationSidebarEntry[] {
  return sections.flatMap((section, index) => [
    {
      first: index === 0,
      key: `section-${section.key}`,
      kind: "section" as const,
      label: section.label,
    },
    ...section.conversations.map((conversation) => ({
      conversation,
      key: `conversation-${conversation.id}`,
      kind: "conversation" as const,
    })),
  ]);
}

/** Status glyph for a sidebar row; private rows use the lock instead of a dot. */
function ConversationListStatusIcon(props: {
  isPrivate: boolean;
  status: VisualStatus;
}) {
  if (props.isPrivate) {
    return (
      <LockKeyhole
        aria-label="Private conversation"
        className={cn(
          "size-3 shrink-0",
          props.status === "active" &&
            "animate-[junior-active-indicator_1.8s_ease-in-out_infinite] text-emerald-300 drop-shadow-[0_0_6px_rgba(110,231,183,0.55)] motion-reduce:animate-none",
          props.status === "failed" && "text-rose-300",
          props.status === "idle" && "text-dashboard-text-muted",
        )}
      />
    );
  }

  if (props.status === "active") {
    return <ActiveIndicator className="size-1.5" />;
  }

  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        props.status === "failed" && "bg-rose-300",
        props.status === "idle" && "bg-white/25",
      )}
    />
  );
}

const ConversationSidebarRow = memo(function ConversationSidebarRow(props: {
  conversation: Conversation;
  onArchiveError(conversation: Conversation): void;
  onArchived(conversation: Conversation): void;
  selected: boolean;
}) {
  const archive = useArchiveConversation(props.conversation.id, {
    onError: () => props.onArchiveError(props.conversation),
    onSuccess: (archived) => {
      if (archived) props.onArchived(props.conversation);
    },
  });
  const status = visualStatusForConversation(props.conversation);
  const location = slackLocationLabel(props.conversation, {
    includeId: false,
  });
  const title = conversationDisplayTitle(props.conversation);
  const hasAnnotations = Boolean(props.conversation.sidebarAnnotations?.length);
  const isPrivate = props.conversation.visibility === "private";
  // Linked work is denser and more actionable than channel; hide channel when
  // annotations own the meta row. Also skip a location that only restates the
  // title (common for redacted private destinations).
  const showLocation =
    Boolean(location) &&
    !hasAnnotations &&
    location?.toLocaleLowerCase() !== title.toLocaleLowerCase();
  const hasMeta = showLocation || hasAnnotations;
  return (
    <div className="mobile-conversation-row group relative min-w-0">
      <Link
        aria-current={props.selected ? "page" : undefined}
        className={cn(
          "block min-w-0 rounded-md px-2.5 py-1.5 text-inherit no-underline transition-colors hover:bg-white/[0.04] max-sm:pr-10",
          props.selected && "bg-white/[0.06]",
        )}
        to={conversationPath(props.conversation.id)}
      >
        <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-1.5">
          <div className="col-start-1 row-start-1 mt-[0.3rem] grid size-3 shrink-0 place-items-center">
            <ConversationListStatusIcon
              isPrivate={isPrivate}
              status={status}
            />
          </div>
          <div className="col-start-2 row-start-1 min-w-0 truncate font-display text-sm font-medium leading-snug text-dashboard-text">
            {title}
          </div>
          {hasMeta ? (
            <div className="col-start-2 row-start-2 mt-0.5 flex min-w-0 items-center gap-1.5 font-mono text-2xs leading-tight text-dashboard-text-muted">
              {showLocation ? (
                <span className="truncate">{location}</span>
              ) : null}
              <ConversationSidebarAnnotations
                annotations={props.conversation.sidebarAnnotations}
              />
            </div>
          ) : null}
        </div>
      </Link>
      <button
        aria-label={`${props.conversation.archivedAt ? "Restore" : "Archive"} ${title}`}
        className="absolute right-1.5 top-1/2 z-10 grid size-7 -translate-y-1/2 cursor-pointer place-items-center rounded-md bg-[#111719] text-dashboard-text-muted shadow-[-8px_0_12px_rgba(9,12,14,0.8)] transition hover:text-dashboard-text focus:outline-none focus:ring-2 focus:ring-cyan-300/35 sm:pointer-events-none sm:opacity-0 sm:focus:pointer-events-auto sm:focus:opacity-100 sm:group-focus-within:pointer-events-auto sm:group-focus-within:opacity-100 sm:group-hover:pointer-events-auto sm:group-hover:opacity-100 disabled:cursor-not-allowed"
        disabled={archive.isPending}
        onClick={() =>
          archive.mutate({
            archived: !props.conversation.archivedAt,
            lastSeenAt: props.conversation.lastSeenAt,
          })
        }
        title={`${props.conversation.archivedAt ? "Restore" : "Archive"} ${title}`}
        type="button"
      >
        {props.conversation.archivedAt ? (
          <ArchiveRestore aria-hidden="true" size={14} />
        ) : (
          <Archive aria-hidden="true" size={14} />
        )}
      </button>
    </div>
  );
});

function ArchiveConversationErrorNotice(props: {
  conversation: Conversation;
  onDismiss(): void;
}) {
  const title = conversationDisplayTitle(props.conversation);
  // Restore failures still carry archivedAt from the archived row.
  const actionTitle = props.conversation.archivedAt
    ? "Could not restore"
    : "Could not archive";
  return (
    <Notice
      action={
        <NoticeAction onClick={props.onDismiss} title="Dismiss" tone="error">
          Dismiss
        </NoticeAction>
      }
      detail={title}
      icon={CircleAlert}
      title={actionTitle}
      tone="error"
    />
  );
}

function ArchivedConversationNotice(props: {
  conversation: Conversation;
  onRestored(): void;
}) {
  const restore = useArchiveConversation(props.conversation.id, {
    onSuccess: (archived) => {
      if (!archived) props.onRestored();
    },
  });
  const title = conversationDisplayTitle(props.conversation);

  useEffect(() => {
    if (restore.isPending || restore.error) return;
    const timeout = window.setTimeout(props.onRestored, 6_000);
    return () => window.clearTimeout(timeout);
  }, [
    props.conversation.id,
    props.onRestored,
    restore.error,
    restore.isPending,
  ]);

  return (
    <Notice
      action={
        <NoticeAction
          aria-label={`Undo archive for ${title}`}
          disabled={restore.isPending}
          onClick={() =>
            restore.mutate({
              archived: false,
              lastSeenAt: props.conversation.lastSeenAt,
            })
          }
          title={`Undo archive for ${title}`}
        >
          {restore.isPending ? "Restoring…" : "Undo"}
        </NoticeAction>
      }
      detail={title}
      icon={ArchiveRestore}
      title="Conversation archived"
    >
      {restore.error ? (
        <div
          className="border-t border-rose-300/25 bg-rose-400/[0.12] px-3 py-2 font-mono text-xs text-rose-50/85"
          role="alert"
        >
          Could not restore the conversation.
        </div>
      ) : null}
    </Notice>
  );
}
