import { useCallback, useEffect, useState } from "react";
import { Archive, ArchiveRestore, SquarePen } from "lucide-react";
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
      <div className="px-5 pb-3 pt-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="m-0 font-display text-xl font-medium leading-tight text-dashboard-text">
            Conversations
          </h2>
          <button
            aria-label="New conversation"
            className="grid size-8 cursor-pointer place-items-center rounded-md text-dashboard-text-muted transition hover:bg-white/[0.05] hover:text-dashboard-text focus:outline-none focus:ring-2 focus:ring-cyan-300/35"
            onClick={props.onNewConversation}
            title="New conversation"
            type="button"
          >
            <SquarePen aria-hidden="true" size={17} />
          </button>
        </div>
      </div>
      <div className="px-3 pb-3">
        <SearchInput
          label="Search your conversations"
          onChange={props.onQueryChange}
          placeholder="Search conversations…"
          size="default"
          value={props.query}
        />
      </div>
      <div className="min-h-0 overflow-y-auto overscroll-contain px-2 pb-2">
        {props.error ? (
          <div className="p-3">
            <EmptyTelemetry>{props.error}</EmptyTelemetry>
          </div>
        ) : (
          <AnimatedList
            ariaLabel="Your conversations"
            className="grid gap-1"
            empty={
              !props.loading ? (
                <div className="p-3">
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
                <h3 className="m-0 px-3 pb-1 pt-4 font-display text-xs font-semibold uppercase tracking-[0.08em] text-dashboard-text-muted/60">
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
        <div className="absolute bottom-3 left-3 right-3 z-20 grid gap-2">
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
          "block min-w-0 rounded-lg border border-transparent px-3 py-3 text-inherit no-underline transition-all hover:bg-white/[0.035]",
          props.selected && "border-cyan-300/20 bg-cyan-300/[0.07]",
        )}
        to={conversationPath(props.conversation.id)}
      >
        <div className="flex min-w-0 items-center gap-2">
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
          <div className="truncate font-display text-sm font-medium leading-tight text-dashboard-text">
            {title}
          </div>
        </div>
        {location ? (
          <div className="ml-3.5 mt-1.5 truncate font-mono text-xs leading-tight text-dashboard-text-muted">
            {location}
          </div>
        ) : null}
      </Link>
      <button
        aria-label={`Archive ${title}`}
        className="pointer-events-none absolute right-2 top-1/2 z-10 grid size-8 -translate-y-1/2 cursor-pointer place-items-center rounded-md bg-[#111719] text-dashboard-text-muted opacity-0 shadow-[-8px_0_12px_rgba(9,12,14,0.8)] transition hover:text-dashboard-text focus:pointer-events-auto focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-cyan-300/35 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 disabled:cursor-not-allowed"
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
        <Archive aria-hidden="true" size={15} />
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
    <div className="rounded-lg border border-rose-300/25 bg-[#111719] px-3 py-2.5 shadow-[0_12px_32px_rgba(0,0,0,0.45)]">
      <div className="flex min-w-0 items-center gap-3">
        <div
          className="min-w-0 flex-1 font-mono text-xs text-rose-200/80"
          role="alert"
        >
          Could not archive {title}.
        </div>
        <button
          className="shrink-0 cursor-pointer rounded border border-white/15 px-2 py-1 font-mono text-xs text-dashboard-text-muted transition hover:border-white/30 hover:text-dashboard-text focus:outline-none focus:ring-2 focus:ring-cyan-300/35"
          onClick={props.onDismiss}
          title="Dismiss"
          type="button"
        >
          Dismiss
        </button>
      </div>
    </div>
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
    <div className="overflow-hidden rounded-xl border border-cyan-200/20 bg-[linear-gradient(135deg,rgba(25,42,45,0.98),rgba(15,21,23,0.98))] shadow-[0_16px_40px_rgba(0,0,0,0.5)] backdrop-blur-md">
      <div className="flex min-w-0 items-center gap-3 px-3 py-3">
        <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-cyan-300/10 text-cyan-100/80">
          <ArchiveRestore aria-hidden="true" size={16} />
        </div>
        <div className="min-w-0 flex-1" role="status">
          <div className="font-display text-sm font-medium text-dashboard-text">
            Conversation archived
          </div>
          <div className="mt-0.5 truncate font-mono text-xs text-dashboard-text-muted">
            {title}
          </div>
        </div>
        <button
          aria-label={`Undo archive for ${title}`}
          className="shrink-0 cursor-pointer rounded-lg bg-cyan-200/10 px-3 py-1.5 font-display text-xs font-medium text-cyan-100 transition hover:bg-cyan-200/20 focus:outline-none focus:ring-2 focus:ring-cyan-300/35 disabled:cursor-not-allowed disabled:opacity-40"
          disabled={restore.isPending}
          onClick={() =>
            restore.mutate({
              archived: false,
              lastSeenAt: props.conversation.lastSeenAt,
            })
          }
          title={`Undo archive for ${title}`}
          type="button"
        >
          {restore.isPending ? "Restoring…" : "Undo"}
        </button>
      </div>
      {restore.error ? (
        <div
          className="border-t border-rose-300/15 bg-rose-300/[0.06] px-3 py-2 font-mono text-xs text-rose-200/80"
          role="alert"
        >
          Could not restore the conversation.
        </div>
      ) : null}
    </div>
  );
}
