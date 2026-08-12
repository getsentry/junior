import { useCallback, useEffect, useState } from "react";
import { Archive, ArchiveRestore, CircleAlert, SquarePen } from "lucide-react";
import { Link } from "react-router";

import { useArchiveConversation } from "./queries";
import {
  conversationDisplayTitle,
  conversationPath,
  slackLocationLabel,
  visualStatusForConversation,
} from "../format";
import { cn } from "../styles";
import type { Conversation } from "../types";
import { ActiveIndicator } from "../components/ActiveIndicator";
import { Notice, NoticeAction } from "../components/Notice";
import { AnimatedList } from "./AnimatedList";
import {
  buildConversationSections,
  type ConversationSection,
} from "./conversationSections";
import { EmptyTelemetry } from "../components/EmptyTelemetry";
import { SearchInput } from "../components/SearchInput";

type ConversationSidebarEntry =
  | { key: string; kind: "section"; label: string }
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
  onNewConversation(): void;
  onQueryChange(value: string): void;
}) {
  const [archivedConversation, setArchivedConversation] =
    useState<Conversation>();
  const [archiveError, setArchiveError] = useState<Conversation>();
  const dismissArchivedConversation = useCallback(
    () => setArchivedConversation(undefined),
    [],
  );
  const entries = conversationSidebarEntries(
    buildConversationSections(props.conversations, {
      nowMs: Date.now(),
      timeZone: props.timeZone,
    }),
  );
  return (
    <aside className="relative grid h-full min-h-0 min-w-0 grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden border-r border-white/[0.07] bg-white/[0.02]">
      <div className="px-3 pb-2 pt-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="m-0 font-display text-lg font-medium leading-tight text-dashboard-text">
            Conversations
          </h2>
          <button
            aria-label="New conversation"
            className="grid size-7 cursor-pointer place-items-center rounded-md text-dashboard-text-muted transition hover:bg-white/[0.05] hover:text-dashboard-text focus:outline-none focus:ring-2 focus:ring-cyan-300/35"
            onClick={props.onNewConversation}
            title="New conversation"
            type="button"
          >
            <SquarePen aria-hidden="true" size={15} />
          </button>
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
      <div className="min-h-0 overflow-y-auto overscroll-contain px-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
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
                <h3 className="m-0 px-2.5 pb-0.5 pt-4 font-display text-2xs font-semibold uppercase tracking-[0.08em] text-dashboard-text-muted/55 first:pt-1.5">
                  {entry.label}
                </h3>
              ) : (
                <ConversationSidebarRow
                  conversation={entry.conversation}
                  onArchiveError={setArchiveError}
                  onArchived={(conversation) => {
                    setArchiveError((current) =>
                      current?.id === conversation.id ? undefined : current,
                    );
                    setArchivedConversation(conversation);
                  }}
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
  return sections.flatMap((section) => [
    {
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

function ConversationSidebarRow(props: {
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
  return (
    <div className="group relative min-w-0">
      <Link
        aria-current={props.selected ? "page" : undefined}
        className={cn(
          "block min-w-0 rounded-md px-2.5 py-1.5 text-inherit no-underline transition-colors hover:bg-white/[0.04]",
          props.selected && "bg-white/[0.06]",
        )}
        to={conversationPath(props.conversation.id)}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          {status === "active" ? (
            <ActiveIndicator className="size-1.5" />
          ) : (
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                status === "failed" && "bg-rose-300",
                status === "idle" && "bg-white/25",
              )}
            />
          )}
          <div className="truncate font-display text-sm font-medium leading-snug text-dashboard-text">
            {title}
          </div>
        </div>
        {location ? (
          <div className="ml-3 mt-0.5 truncate font-mono text-2xs leading-tight text-dashboard-text-muted">
            {location}
          </div>
        ) : null}
      </Link>
      <button
        aria-label={`Archive ${title}`}
        className="pointer-events-none absolute right-1.5 top-1/2 z-10 grid size-7 -translate-y-1/2 cursor-pointer place-items-center rounded-md bg-[#111719] text-dashboard-text-muted opacity-0 shadow-[-8px_0_12px_rgba(9,12,14,0.8)] transition hover:text-dashboard-text focus:pointer-events-auto focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-cyan-300/35 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 disabled:cursor-not-allowed"
        disabled={archive.isPending}
        onClick={() =>
          archive.mutate({
            archived: true,
            lastSeenAt: props.conversation.lastSeenAt,
          })
        }
        title={`Archive ${title}`}
        type="button"
      >
        <Archive aria-hidden="true" size={14} />
      </button>
    </div>
  );
}

function ArchiveConversationErrorNotice(props: {
  conversation: Conversation;
  onDismiss(): void;
}) {
  const title = conversationDisplayTitle(props.conversation);
  return (
    <Notice
      action={
        <NoticeAction onClick={props.onDismiss} title="Dismiss" tone="error">
          Dismiss
        </NoticeAction>
      }
      detail={title}
      icon={CircleAlert}
      title="Could not archive"
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
