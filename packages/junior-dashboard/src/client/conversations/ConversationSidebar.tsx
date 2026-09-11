import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Archive, ArchiveRestore, CircleAlert, SquarePen } from "lucide-react";
import { Link } from "react-router";

import { useArchiveConversation } from "./queries";
import { conversationPath } from "./conversationRoutes";
import {
  conversationDisplayTitle,
  slackLocationLabel,
  visualStatusForConversation,
} from "../format";
import { cn } from "../styles";
import type { Conversation } from "../types";
import { Notice, NoticeAction } from "../components/Notice";
import { AnimatedList } from "./AnimatedList";
import {
  buildConversationSections,
  type ConversationSection,
} from "./conversationSections";
import { EmptyTelemetry } from "../components/EmptyTelemetry";
import { SearchInput } from "../components/SearchInput";
import { Skeleton } from "../components/Skeleton";
import { ConversationSidebarAnnotations } from "./ConversationMeta";
import { ConversationListStatusIcon } from "./ConversationListStatusIcon";

type ConversationSidebarEntry =
  | { first: boolean; key: string; kind: "section"; label: string }
  | { conversation: Conversation; key: string; kind: "conversation" };

// Tracks the attempted direction alongside the conversation so a failed
// archive can never read the row's already-optimistic archived state.
type ArchiveErrorState = { conversation: Conversation; wasArchiving: boolean };

const conversationEntryKey = (entry: ConversationSidebarEntry) => entry.key;

/** Render the compact personal conversation picker used by the home workspace. */
export function ConversationSidebar(props: {
  conversations: Conversation[];
  error?: string;
  finishedConversationIds: ReadonlySet<string>;
  loading: boolean;
  query: string;
  selectedId?: string;
  timeZone: string;
  /**
   * `panel` = split-pane dock with internal scroll.
   * `landing` = flow nav under create compose (parent owns scroll).
   */
  variant?: "panel" | "landing";
  onNewConversation(): void;
  onQueryChange(value: string): void;
}) {
  const variant = props.variant ?? "panel";
  const isLanding = variant === "landing";
  const [archivedConversation, setArchivedConversation] =
    useState<Conversation>();
  const [archiveError, setArchiveError] = useState<ArchiveErrorState>();
  const dismissArchivedConversation = useCallback(
    () => setArchivedConversation(undefined),
    [],
  );
  const handleArchiveError = useCallback(
    (conversation: Conversation, wasArchiving: boolean) => {
      setArchiveError({ conversation, wasArchiving });
    },
    [],
  );
  const handleArchived = useCallback((conversation: Conversation) => {
    setArchiveError((current) =>
      current?.conversation.id === conversation.id ? undefined : current,
    );
    setArchivedConversation(conversation);
  }, []);
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
      <div className={cn("px-3 pb-2", isLanding ? "pt-5" : "pt-3")}>
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
        ) : props.loading && entries.length === 0 ? (
          <ConversationRowsLoading />
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
                  finishedSinceSeen={props.finishedConversationIds.has(
                    entry.conversation.id,
                  )}
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
        <div
          className={cn(
            // Landing is content-tall (parent scrolls). Keep notices on the
            // visible viewport instead of the end of the long list.
            isLanding
              ? "fixed bottom-[max(0.75rem,env(safe-area-inset-bottom))] left-3 right-3 z-30 grid gap-2"
              : "absolute bottom-[max(0.75rem,env(safe-area-inset-bottom))] left-3 right-3 z-20 grid gap-2",
          )}
        >
          {archiveError ? (
            <ArchiveConversationErrorNotice
              conversation={archiveError.conversation}
              onDismiss={() => setArchiveError(undefined)}
              wasArchiving={archiveError.wasArchiving}
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

/** Match the usual conversation row density while the first feed loads. */
function ConversationRowsLoading() {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className="grid gap-0.5"
      role="status"
    >
      <span className="sr-only">Loading your conversations</span>
      <Skeleton className="mb-1 ml-2.5 mt-1.5 h-2.5 w-12" />
      {Array.from({ length: 7 }, (_, index) => (
        <div className="grid gap-2 rounded-md px-2.5 py-2" key={index}>
          <Skeleton
            className={cn("h-3", index % 3 === 0 ? "w-4/5" : "w-3/5")}
          />
          <Skeleton className="h-2.5 w-2/5 opacity-70" />
        </div>
      ))}
    </div>
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

const ConversationSidebarRow = memo(function ConversationSidebarRow(props: {
  conversation: Conversation;
  finishedSinceSeen: boolean;
  onArchiveError(conversation: Conversation, wasArchiving: boolean): void;
  onArchived(conversation: Conversation): void;
  selected: boolean;
}) {
  const archive = useArchiveConversation(props.conversation.id, {
    // Read the attempted direction from the mutation call, not the (possibly
    // already optimistically updated) conversation prop, so a failed archive
    // never gets mislabeled as a failed restore.
    onError: () =>
      props.onArchiveError(
        props.conversation,
        archive.variables?.archived ?? true,
      ),
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
              finishedSinceSeen={props.finishedSinceSeen}
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
  wasArchiving: boolean;
}) {
  const title = conversationDisplayTitle(props.conversation);
  const actionTitle = props.wasArchiving
    ? "Could not archive"
    : "Could not restore";
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
