import { memo, useCallback, useMemo } from "react";
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  Inbox,
  LockKeyhole,
  Pin,
  SquarePen,
} from "lucide-react";
import { Link } from "react-router";

import { useArchiveConversation } from "./conversationArchive";
import { useConversationActionToasts } from "./conversationActionToasts";
import { usePinConversation } from "./usePinConversation";
import { conversationPath } from "./conversationRoutes";
import {
  conversationDisplayTitle,
  visualStatusForConversation,
} from "../format";
import { formatCompactAge } from "./conversationAge";
import { cn } from "../styles";
import type { Conversation } from "../types";
import { AnimatedList } from "./AnimatedList";
import {
  buildConversationSections,
  type ConversationSection,
} from "./conversationSections";
import { ConversationSectionHeading } from "./ConversationSectionHeading";
import { usePrefetchConversation } from "./conversationPrefetch";
import { useCollapsedConversationSections } from "./useCollapsedConversationSections";
import { EmptyTelemetry } from "../components/EmptyTelemetry";
import { SearchInput } from "../components/SearchInput";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { Spinner } from "../components/ui/spinner";
import type { WaitingConversation } from "../review-desk/queries";

type ConversationSidebarEntry =
  | {
      collapsed: boolean;
      count: number;
      first: boolean;
      key: string;
      kind: "section";
      label: string;
      sectionKey: string;
    }
  | { conversation: Conversation; key: string; kind: "conversation" };

const ROW_ACTION_BUTTON_CLASS =
  "absolute top-0.5 z-10 grid size-7 cursor-pointer place-items-center rounded-md bg-dashboard-surface-active text-dashboard-text-muted transition hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-dashboard-focus sm:pointer-events-none sm:opacity-0 sm:focus:pointer-events-auto sm:focus:opacity-100 sm:group-focus-within:pointer-events-auto sm:group-focus-within:opacity-100 sm:group-hover:pointer-events-auto sm:group-hover:opacity-100 disabled:cursor-not-allowed";

const conversationEntryKey = (entry: ConversationSidebarEntry) => entry.key;

/** Render the compact personal conversation picker used by the home workspace. */
export function ConversationSidebar(props: {
  conversations: Conversation[];
  error?: string;
  finishedConversationIds: ReadonlySet<string>;
  /** Opened while unread; keeps its unread place until another one opens. */
  heldConversationId?: string;
  loading: boolean;
  query: string;
  selectedId?: string;
  timeZone: string;
  waitingConversations: ReadonlyMap<string, WaitingConversation>;
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
  const { clearActionError, showActionError, showArchiveError, showArchived } =
    useConversationActionToasts();
  const handlePinError = useCallback(
    (conversation: Conversation, wasPinning: boolean) => {
      showActionError(
        conversation,
        wasPinning ? "Could not pin" : "Could not unpin",
      );
    },
    [showActionError],
  );
  const { collapsedKeys, toggle: toggleSection } =
    useCollapsedConversationSections();
  // Rebuild section rows only when their inputs change. Avoid fresh Date.now()
  // arrays on unrelated parent renders while the reader is scrolling.
  const entries = useMemo(
    () =>
      conversationSidebarEntries(
        buildConversationSections(props.conversations, {
          attentionIds: new Set([
            ...props.waitingConversations.keys(),
            ...props.finishedConversationIds,
            ...(props.heldConversationId ? [props.heldConversationId] : []),
          ]),
          nowMs: Date.now(),
          timeZone: props.timeZone,
        }),
        collapsedKeys,
      ),
    [
      collapsedKeys,
      props.conversations,
      props.finishedConversationIds,
      props.heldConversationId,
      props.timeZone,
      props.waitingConversations,
    ],
  );
  return (
    <aside
      className={cn(
        "relative min-w-0",
        isLanding
          ? "border-t border-dashboard-border bg-transparent"
          : "grid h-full min-h-0 grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden border-r border-dashboard-border bg-dashboard-surface-panel",
      )}
    >
      <div className="px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="m-0 font-display text-base font-medium leading-tight text-dashboard-text">
            {isLanding ? "Your conversations" : "Conversations"}
          </h2>
          <div className="flex items-center gap-0.5">
            {isLanding ? null : (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      aria-label="New conversation"
                      className="size-7"
                      onClick={props.onNewConversation}
                      size="icon"
                    >
                      <SquarePen aria-hidden="true" size={15} />
                    </Button>
                  }
                />
                <TooltipContent size="compact">New conversation</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
      </div>
      <div className="px-4 pb-2">
        <SearchInput
          className="border-dashboard-border-subtle bg-transparent hover:border-dashboard-border hover:bg-dashboard-fill-faint"
          label="Search your conversations"
          onChange={props.onQueryChange}
          placeholder="Search conversations…"
          size="compact"
          value={props.query}
        />
      </div>
      <div
        className={cn(
          "px-3",
          isLanding
            ? "pb-[max(1rem,env(safe-area-inset-bottom))]"
            : "thin-scrollbar min-h-0 overflow-y-auto overscroll-contain pb-[max(0.5rem,env(safe-area-inset-bottom))]",
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
                <ConversationSectionHeading
                  className={cn("px-3 pb-1", entry.first ? "pt-1" : "pt-3")}
                  collapsed={entry.collapsed}
                  count={entry.count}
                  label={entry.label}
                  onToggle={() => toggleSection(entry.sectionKey)}
                />
              ) : (
                <ConversationSidebarRow
                  conversation={entry.conversation}
                  onArchiveError={showArchiveError}
                  onArchived={showArchived}
                  onPinError={handlePinError}
                  onPinned={clearActionError}
                  selected={entry.conversation.id === props.selectedId}
                  unread={props.finishedConversationIds.has(
                    entry.conversation.id,
                  )}
                  waiting={props.waitingConversations.get(
                    entry.conversation.id,
                  )}
                />
              )
            }
            role="navigation"
          />
        )}
      </div>
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
      {Array.from({ length: 10 }, (_, index) => (
        <div
          className="flex items-center justify-between gap-3 rounded-lg py-2 pl-[1.625rem] pr-3"
          key={index}
        >
          <Skeleton
            className={cn("h-4", index % 3 === 0 ? "w-4/5" : "w-3/5")}
          />
          <Skeleton className="h-3 w-6 opacity-70" />
        </div>
      ))}
    </div>
  );
}

function conversationSidebarEntries(
  sections: ConversationSection[],
  collapsedKeys: ReadonlySet<string>,
): ConversationSidebarEntry[] {
  return sections.flatMap((section, index) => {
    const collapsed = collapsedKeys.has(section.key);
    return [
      {
        collapsed,
        count: section.conversations.length,
        first: index === 0,
        key: `section-${section.key}`,
        kind: "section" as const,
        label: section.label,
        sectionKey: section.key,
      },
      ...(collapsed ? [] : section.conversations).map((conversation) => ({
        conversation,
        key: `conversation-${conversation.id}`,
        kind: "conversation" as const,
      })),
    ];
  });
}

const ConversationSidebarRow = memo(function ConversationSidebarRow(props: {
  conversation: Conversation;
  onArchiveError(conversation: Conversation, wasArchiving: boolean): void;
  onArchived(conversation: Conversation): void;
  onPinError(conversation: Conversation, wasPinning: boolean): void;
  onPinned(conversation: Conversation): void;
  selected: boolean;
  unread: boolean;
  waiting?: WaitingConversation;
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
  const pin = usePinConversation(props.conversation.id, {
    onError: (pinned) => props.onPinError(props.conversation, pinned),
    onSuccess: () => props.onPinned(props.conversation),
  });
  const prefetch = usePrefetchConversation(props.conversation.id);
  const pinned = Boolean(props.conversation.pinnedAt);
  const status = visualStatusForConversation(props.conversation);
  const title = conversationDisplayTitle(props.conversation);
  // Unread and waiting rows read like unread mail: a dot and a bold title.
  const emphasized = props.unread || Boolean(props.waiting);
  return (
    <div
      {...prefetch}
      className={cn(
        "mobile-conversation-row group relative min-w-0 rounded-lg transition-colors hover:bg-dashboard-fill-hover",
        props.selected && "bg-dashboard-surface-active",
      )}
    >
      <Link
        aria-current={props.selected ? "page" : undefined}
        className="grid min-w-0 grid-cols-[0.375rem_minmax(0,1fr)_auto] items-center gap-x-2 rounded-lg px-3 py-1.5 text-inherit no-underline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus max-sm:pr-10"
        to={conversationPath(props.conversation.id)}
      >
        <span className="grid place-items-center">
          {emphasized ? (
            <span
              aria-label={props.waiting ? "Waiting on you" : "Unread"}
              className="size-1.5 shrink-0 rounded-full bg-dashboard-accent"
              role="img"
            />
          ) : props.conversation.visibility === "private" ? (
            <LockKeyhole
              aria-label="Private conversation"
              className="size-3 shrink-0 text-dashboard-text-faint"
            />
          ) : null}
        </span>
        <span
          className={cn(
            "min-w-0 truncate font-sans text-sm leading-snug",
            emphasized ? "font-semibold" : props.selected && "font-medium",
            emphasized || props.selected || status === "active"
              ? "text-dashboard-text"
              : "text-dashboard-text-muted",
          )}
        >
          {title}
        </span>
        <ConversationRowState
          lastSeenAt={props.conversation.lastSeenAt}
          status={status}
        />
      </Link>
      {props.waiting ? (
        <Link
          className="mb-1.5 ml-[1.625rem] mr-3 flex min-w-0 items-center gap-1.5 rounded-md border border-dashboard-border-strong bg-dashboard-surface-raised px-2 py-1 font-sans text-xs text-dashboard-text no-underline transition-colors hover:border-dashboard-border-interactive focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-dashboard-focus"
          to={conversationPath(props.conversation.id, { reviewItems: true })}
        >
          <Inbox
            aria-hidden="true"
            className="size-3 shrink-0 text-dashboard-text-muted"
          />
          <span className="min-w-0 truncate">{props.waiting.title}</span>
          {props.waiting.count > 1 ? (
            <span className="ml-auto shrink-0 text-dashboard-text-faint">
              +{props.waiting.count - 1} more
            </span>
          ) : null}
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-3 shrink-0 text-dashboard-text-muted",
              props.waiting.count > 1 ? undefined : "ml-auto",
            )}
          />
        </Link>
      ) : null}
      {/* Mobile rows pin from the conversation menu, so only the archive
          button takes row space there. Archived rows restore before they pin. */}
      {props.conversation.archivedAt ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                aria-label={`${pinned ? "Unpin" : "Pin"} ${title}`}
                aria-pressed={pinned}
                className={cn(ROW_ACTION_BUTTON_CLASS, "right-9 max-sm:hidden")}
                disabled={pin.isPending}
                onClick={() => pin.mutate(!pinned)}
                type="button"
              >
                <Pin
                  aria-hidden="true"
                  fill={pinned ? "currentColor" : "none"}
                  size={14}
                />
              </button>
            }
          />
          <TooltipContent size="compact">
            {pinned ? "Unpin" : "Pin"}
          </TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              aria-label={`${props.conversation.archivedAt ? "Restore" : "Archive"} ${title}`}
              className={cn(ROW_ACTION_BUTTON_CLASS, "right-1.5")}
              disabled={archive.isPending}
              onClick={() =>
                archive.mutate({
                  archived: !props.conversation.archivedAt,
                  lastSeenAt: props.conversation.lastSeenAt,
                })
              }
              type="button"
            >
              {props.conversation.archivedAt ? (
                <ArchiveRestore aria-hidden="true" size={14} />
              ) : (
                <Archive aria-hidden="true" size={14} />
              )}
            </button>
          }
        />
        <TooltipContent size="compact">
          {props.conversation.archivedAt ? "Restore" : "Archive"}
        </TooltipContent>
      </Tooltip>
    </div>
  );
});

/** Show the row age, or the status when the conversation runs or failed. */
function ConversationRowState(props: {
  lastSeenAt: string;
  status: ReturnType<typeof visualStatusForConversation>;
}) {
  if (props.status === "active") {
    return (
      <Spinner
        aria-label="Running"
        className="size-3.5 text-dashboard-text-muted"
      />
    );
  }
  if (props.status === "failed") {
    return <span className="font-sans text-xs text-rose-400">Failed</span>;
  }
  return (
    <span className="font-sans text-xs tabular-nums text-dashboard-text-faint">
      {formatCompactAge(props.lastSeenAt)}
    </span>
  );
}
