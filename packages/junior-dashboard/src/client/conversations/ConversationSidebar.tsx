import { memo, useCallback, useMemo, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowUp,
  Mail,
  MailOpen,
  Pencil,
  Pin,
  SquarePen,
} from "lucide-react";
import { Link } from "react-router";

import { useArchiveConversation } from "./conversationArchive";
import { useConversationActionToasts } from "./conversationActionToasts";
import { useMarkConversationUnread } from "./useMarkConversationUnread";
import { usePinConversation } from "./usePinConversation";
import { useRenameConversation } from "./useRenameConversation";
import { RenameConversationDialog } from "./RenameConversationDialog";
import {
  PinnedConversationOrder,
  usePinnedRowDrag,
  type PinnedRowDrag,
} from "./PinnedConversationOrder";
import type { ReorderPins } from "./useReorderPinnedConversations";
import { conversationPath } from "./conversationRoutes";
import {
  conversationDisplayTitle,
  isIdleConversation,
  visualStatusForConversation,
} from "../format";
import { formatCompactAge } from "./conversationAge";
import { cn } from "../styles";
import type { Conversation } from "../types";
import { AnimatedList } from "./AnimatedList";
import { WaitingChip } from "./WaitingChip";
import {
  buildConversationSections,
  type ConversationSection,
} from "./conversationSections";
import { ConversationStatusText } from "./ConversationListStatusIcon";
import { useHeldListOrder } from "./heldListOrder";
import { ConversationSectionHeading } from "./ConversationSectionHeading";
import {
  ConversationSidebarThreadRow,
  ConversationSidebarThreadToggle,
} from "./ConversationSidebarThreadRow";
import { sidebarThreads } from "./sidebarThreads";
import { usePrefetchConversation } from "./conversationPrefetch";
import { useCollapsedConversationSections } from "./useCollapsedConversationSections";
import { EmptyTelemetry } from "../components/EmptyTelemetry";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../components/ui/context-menu";
import { Button } from "../components/ui/button";
import { ScrollArea } from "../components/ui/scroll-area";
import { Skeleton } from "../components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { Spinner } from "../components/ui/spinner";
import {
  useWaitingConversationsSettled,
  type WaitingConversation,
} from "../review-desk/queries";

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
  | { conversation: Conversation; key: string; kind: "conversation" }
  | { conversation: Conversation; depth: number; key: string; kind: "thread" }
  | {
      expanded: boolean;
      hiddenCount: number;
      key: string;
      kind: "thread-toggle";
      rootId: string;
    };

const ROW_ACTION_BUTTON_CLASS =
  "grid size-7 cursor-pointer place-items-center rounded-md text-dashboard-text-muted transition hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-dashboard-focus disabled:cursor-not-allowed";

// While the row actions show, the row content fades out under them, so the
// title does not end in a hard cut. --row-actions-width is set per row.
const ROW_ACTIONS_FADE_CLASS =
  "sm:group-hover:[mask-image:linear-gradient(to_left,transparent_var(--row-actions-width),black_calc(var(--row-actions-width)+2rem))] sm:group-focus-within:[mask-image:linear-gradient(to_left,transparent_var(--row-actions-width),black_calc(var(--row-actions-width)+2rem))]";

const conversationEntryKey = (entry: ConversationSidebarEntry) => entry.key;

/** Render the compact personal conversation picker beside the workspace. */
export function ConversationSidebar(props: {
  conversations: Conversation[];
  error?: string;
  loading: boolean;
  selectedId?: string;
  timeZone: string;
  waitingConversations: ReadonlyMap<string, WaitingConversation>;
  onNewConversation(): void;
  onReorderPins: ReorderPins;
}) {
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
  const handleUnreadError = useCallback(
    (conversation: Conversation, wasMarkingUnread: boolean) => {
      showActionError(
        conversation,
        wasMarkingUnread
          ? "Could not mark as unread"
          : "Could not mark as read",
      );
    },
    [showActionError],
  );
  const handleRenameError = useCallback(
    (conversation: Conversation) =>
      showActionError(conversation, "Could not rename"),
    [showActionError],
  );
  const { collapsedKeys, toggle: toggleSection } =
    useCollapsedConversationSections();
  const [expandedThreadRoots, setExpandedThreadRoots] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const toggleThreads = useCallback((rootId: string) => {
    setExpandedThreadRoots((current) => {
      const next = new Set(current);
      if (!next.delete(rootId)) next.add(rootId);
      return next;
    });
  }, []);
  // Rebuild section rows only when their inputs change. Avoid fresh Date.now()
  // arrays on unrelated parent renders while the reader is scrolling.
  const latestSections = useMemo(
    () =>
      buildConversationSections(props.conversations, {
        nowMs: Date.now(),
        timeZone: props.timeZone,
        waiting: props.waitingConversations,
      }),
    [props.conversations, props.timeZone, props.waitingConversations],
  );
  const waitingSettled = useWaitingConversationsSettled();
  const held = useHeldListOrder(latestSections, {
    settled: !props.loading && waitingSettled,
  });
  const entries = useMemo(
    () =>
      conversationSidebarEntries(held.sections, collapsedKeys, {
        expandedThreadRoots,
        selectedId: props.selectedId,
      }),
    [collapsedKeys, expandedThreadRoots, props.selectedId, held.sections],
  );
  const { releaseHold } = held;
  const { onReorderPins } = props;
  const reorderPins = useCallback<ReorderPins>(
    (move) => {
      releaseHold();
      onReorderPins(move);
    },
    [onReorderPins, releaseHold],
  );
  const pinnedConversations = useMemo(
    () =>
      entries.flatMap((entry) =>
        entry.kind === "conversation" && entry.conversation.pinnedAt
          ? [entry.conversation]
          : [],
      ),
    [entries],
  );
  const handleReorderError = useCallback(
    (conversation: Conversation) =>
      showActionError(conversation, "Could not reorder"),
    [showActionError],
  );
  return (
    <aside className="relative grid h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden border-r border-dashboard-border bg-dashboard-surface-panel">
      <div className="px-3 pb-1.5 pt-2.5">
        {/* The chip centers on the rows' icon column, so the label lines up
          with the conversation titles below. */}
        <Button
          className="grid grid-cols-[0.875rem_minmax(0,1fr)] gap-2 rounded-lg px-3 py-2 font-medium leading-snug hover:bg-dashboard-fill-hover focus-visible:bg-dashboard-fill-hover [&_svg]:text-dashboard-accent-text hover:[&_svg]:text-dashboard-accent-text focus-visible:[&_svg]:text-dashboard-accent-text"
          onClick={props.onNewConversation}
          size="menu"
        >
          <span
            aria-hidden="true"
            className="grid size-[1.125rem] place-items-center justify-self-center rounded-md bg-dashboard-accent/[0.14] dark:bg-dashboard-accent/[0.22]"
          >
            <SquarePen className="size-3" strokeWidth={2.25} />
          </span>
          New conversation
        </Button>
      </div>
      <ScrollArea
        {...held.holdProps}
        viewportClassName="px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
      >
        <ListUpdatesPill count={held.pending} onApply={held.applyPending} />
        {props.error ? (
          <div className="p-2">
            <EmptyTelemetry>{props.error}</EmptyTelemetry>
          </div>
        ) : props.loading && entries.length === 0 ? (
          <ConversationRowsLoading />
        ) : (
          <PinnedConversationOrder
            conversations={pinnedConversations}
            onError={handleReorderError}
            reorder={reorderPins}
          >
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
                ) : entry.kind === "thread-toggle" ? (
                  <ConversationSidebarThreadToggle
                    expanded={entry.expanded}
                    hiddenCount={entry.hiddenCount}
                    onToggle={() => toggleThreads(entry.rootId)}
                  />
                ) : entry.kind === "thread" ? (
                  <ConversationSidebarThreadRow
                    conversation={entry.conversation}
                    depth={entry.depth}
                    selected={entry.conversation.id === props.selectedId}
                    waiting={props.waitingConversations.has(
                      entry.conversation.id,
                    )}
                  />
                ) : (
                  <ConversationSidebarEntryRow
                    conversation={entry.conversation}
                    onArchiveError={showArchiveError}
                    onArchived={showArchived}
                    onPinError={handlePinError}
                    onPinned={clearActionError}
                    onUnreadError={handleUnreadError}
                    onRenameError={handleRenameError}
                    onRowAction={releaseHold}
                    selected={entry.conversation.id === props.selectedId}
                    waiting={props.waitingConversations.get(
                      entry.conversation.id,
                    )}
                  />
                )
              }
              role="navigation"
            />
          </PinnedConversationOrder>
        )}
      </ScrollArea>
    </aside>
  );
}

/**
 * Offer the order that the held list keeps back. The list holds its order
 * while the reader points at it or works in it; this applies the new order.
 */
function ListUpdatesPill(props: { count: number; onApply(): void }) {
  return (
    <div
      aria-live="polite"
      className="pointer-events-none sticky top-0 z-10 flex h-0 items-start justify-center"
    >
      {props.count > 0 ? (
        <button
          className="pointer-events-auto mt-1 inline-flex cursor-pointer items-center gap-1 rounded-full border border-dashboard-border-strong bg-dashboard-surface-raised px-2.5 py-1 font-sans text-xs font-medium text-dashboard-text shadow-sm duration-150 hover:border-dashboard-border-interactive focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-dashboard-focus motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1"
          onClick={props.onApply}
          type="button"
        >
          <ArrowUp aria-hidden="true" className="size-3" />
          {props.count} updated
        </button>
      ) : null}
    </div>
  );
}

/** Match the usual conversation row density while the first feed loads. */
function ConversationRowsLoading() {
  return (
    <div aria-busy="true" aria-live="polite" role="status">
      <span className="sr-only">Loading your conversations</span>
      <ConversationRowSkeletons />
    </div>
  );
}

/** Draw placeholder rows in the sidebar row geometry. Callers own the status text. */
export function ConversationRowSkeletons() {
  return (
    <div aria-hidden="true" className="grid gap-0.5">
      <Skeleton className="mb-1 ml-3 mt-1.5 h-2.5 w-12" />
      {Array.from({ length: 10 }, (_, index) => (
        <div
          className="flex items-center justify-between gap-3 rounded-lg py-2 pl-[2.125rem] pr-3"
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
  threads: { expandedThreadRoots: ReadonlySet<string>; selectedId?: string },
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
      ...(collapsed ? [] : section.conversations).flatMap((conversation) => [
        {
          conversation,
          key: `conversation-${conversation.id}`,
          kind: "conversation" as const,
        },
        ...threadEntries(
          conversation,
          threads.expandedThreadRoots.has(conversation.id),
          threads.selectedId,
        ),
      ]),
    ];
  });
}

/** List the sidebar Threads under one root, then its show more or fewer row. */
function threadEntries(
  root: Conversation,
  expanded: boolean,
  selectedId: string | undefined,
): ConversationSidebarEntry[] {
  const { collapsible, hiddenCount, threads } = sidebarThreads(root.threads, {
    expanded,
    selectedId,
  });
  const entries: ConversationSidebarEntry[] = threads.map((thread) => ({
    ...thread,
    key: `thread-${thread.conversation.id}`,
    kind: "thread" as const,
  }));
  if (collapsible && (expanded || hiddenCount > 0)) {
    entries.push({
      expanded,
      hiddenCount,
      key: `thread-toggle-${root.id}`,
      kind: "thread-toggle",
      rootId: root.id,
    });
  }
  return entries;
}

type ConversationSidebarRowProps = {
  conversation: Conversation;
  /** Set on pinned rows, which drag to reorder. */
  drag?: PinnedRowDrag;
  onArchiveError(conversation: Conversation, wasArchiving: boolean): void;
  onArchived(conversation: Conversation): void;
  onPinError(conversation: Conversation, wasPinning: boolean): void;
  onPinned(conversation: Conversation): void;
  onUnreadError(conversation: Conversation, wasMarkingUnread: boolean): void;
  onRenameError(conversation: Conversation): void;
  /** Runs before a row action that can move rows, so its result shows. */
  onRowAction(): void;
  selected: boolean;
  waiting?: WaitingConversation;
};

/** Render one sidebar row. Only pinned rows join the drag order. */
function ConversationSidebarEntryRow(
  props: Omit<ConversationSidebarRowProps, "drag">,
) {
  return props.conversation.pinnedAt ? (
    <PinnedSidebarRow {...props} />
  ) : (
    <ConversationSidebarRow {...props} />
  );
}

function PinnedSidebarRow(props: Omit<ConversationSidebarRowProps, "drag">) {
  const drag = usePinnedRowDrag(props.conversation.id);
  return <ConversationSidebarRow {...props} drag={drag} />;
}

const ConversationSidebarRow = memo(function ConversationSidebarRow(
  props: ConversationSidebarRowProps,
) {
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
  const markUnread = useMarkConversationUnread(props.conversation.id, {
    onError: (unread) => props.onUnreadError(props.conversation, unread),
  });
  const rename = useRenameConversation(props.conversation.id, {
    onError: () => props.onRenameError(props.conversation),
  });
  const [renaming, setRenaming] = useState(false);
  const prefetch = usePrefetchConversation(props.conversation.id);
  const pinned = Boolean(props.conversation.pinnedAt);
  const status = visualStatusForConversation(props.conversation);
  const title = conversationDisplayTitle(props.conversation);
  // Unread and waiting rows read like unread mail: a dot and a bold title.
  const unread = Boolean(props.conversation.unread);
  const emphasized = unread || Boolean(props.waiting);
  const drag = props.drag;
  // Unread tracks idle conversations only.
  const canMarkUnread = isIdleConversation(props.conversation);
  const archived = Boolean(props.conversation.archivedAt);
  // The leading marker toggles read state. A waiting row's marker is about
  // its review item, so it stays a plain marker.
  const canToggleRead = !props.waiting && (unread || canMarkUnread);
  const togglePin = () => {
    props.onRowAction();
    pin.mutate(!pinned);
  };
  const setUnread = (next: boolean) => {
    props.onRowAction();
    markUnread.mutate(next);
  };
  const toggleArchive = () => {
    props.onRowAction();
    archive.mutate({
      archived: !archived,
      lastSeenAt: props.conversation.lastSeenAt,
    });
  };
  return (
    <ContextMenu>
      <ContextMenuTrigger
        {...prefetch}
        {...drag?.listeners}
        className={cn(
          "mobile-conversation-row group relative min-w-0 rounded-lg transition-colors hover:bg-dashboard-fill-hover data-popup-open:bg-dashboard-fill-hover",
          props.selected && "bg-dashboard-surface-active",
          drag?.dragging && "opacity-40",
          archived
            ? "[--row-actions-width:2.25rem]"
            : "[--row-actions-width:4.25rem]",
        )}
        onKeyDown={drag?.onKeyDown}
        ref={drag?.setNodeRef}
      >
        <Link
          aria-current={props.selected ? "page" : undefined}
          aria-keyshortcuts={drag ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
          className={cn(
            "grid min-w-0 grid-cols-[0.875rem_minmax(0,1fr)_auto] items-center gap-x-2 rounded-lg px-3 py-1.5 text-inherit no-underline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus max-sm:pr-10",
            ROW_ACTIONS_FADE_CLASS,
            // A long press opens the row menu or drags a pin, not the iOS
            // link callout.
            "[-webkit-touch-callout:none]",
          )}
          // The browser's own link drag would take the pointer from the reorder.
          draggable={drag ? false : undefined}
          to={conversationPath(props.conversation.id)}
        >
          <span className="grid place-items-center">
            {emphasized ? (
              <span
                aria-label={props.waiting ? "Waiting on you" : "Unread"}
                className="size-1.5 shrink-0 rounded-full bg-dashboard-accent"
                role="img"
              />
            ) : null}
          </span>
          <span
            className={cn(
              // The title fills its grid column, so the fade reaches only a
              // title that does not fit, in place of an ellipsis.
              "min-w-0 overflow-hidden whitespace-nowrap font-sans text-sm leading-snug [mask-image:linear-gradient(to_left,transparent,black_2rem)]",
              emphasized ? "font-semibold" : props.selected && "font-medium",
              emphasized || props.selected || status === "active"
                ? "text-dashboard-text"
                : "text-dashboard-text-muted",
            )}
          >
            {title}
          </span>
          <ConversationRowState
            conversation={props.conversation}
            status={status}
          />
        </Link>
        {canToggleRead ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  aria-label={`Mark ${title} as ${unread ? "read" : "unread"}`}
                  className="group/read absolute top-1 left-[0.4375rem] z-10 grid size-6 cursor-pointer place-items-center rounded-md transition hover:bg-dashboard-surface-active focus-visible:bg-dashboard-surface-active focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-dashboard-focus disabled:cursor-not-allowed"
                  disabled={markUnread.isPending}
                  onClick={() => setUnread(!unread)}
                  type="button"
                >
                  {/* On hover, preview the state that a click sets. */}
                  <span
                    aria-hidden="true"
                    className={cn(
                      "hidden size-1.5 rounded-full group-hover/read:block group-focus-visible/read:block",
                      unread
                        ? "border border-dashboard-text-muted"
                        : "bg-dashboard-accent",
                    )}
                  />
                </button>
              }
            />
            <TooltipContent size="compact">
              {unread ? "Mark as read" : "Mark as unread"}
            </TooltipContent>
          </Tooltip>
        ) : null}
        {props.waiting ? (
          <WaitingChip
            conversationId={props.conversation.id}
            waiting={props.waiting}
          />
        ) : null}
        {/* Mobile rows pin from the conversation menu, so only the archive
          button takes row space there. Archived rows restore before they pin. */}
        <div className="absolute top-0.5 right-1.5 z-10 flex gap-0.5 transition sm:pointer-events-none sm:opacity-0 sm:group-focus-within:pointer-events-auto sm:group-focus-within:opacity-100 sm:group-hover:pointer-events-auto sm:group-hover:opacity-100">
          {archived ? null : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    aria-label={`${pinned ? "Unpin" : "Pin"} ${title}`}
                    aria-pressed={pinned}
                    className={cn(ROW_ACTION_BUTTON_CLASS, "max-sm:hidden")}
                    disabled={pin.isPending}
                    onClick={togglePin}
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
                  aria-label={`${archived ? "Restore" : "Archive"} ${title}`}
                  className={ROW_ACTION_BUTTON_CLASS}
                  disabled={archive.isPending}
                  onClick={toggleArchive}
                  type="button"
                >
                  {archived ? (
                    <ArchiveRestore aria-hidden="true" size={14} />
                  ) : (
                    <Archive aria-hidden="true" size={14} />
                  )}
                </button>
              }
            />
            <TooltipContent size="compact">
              {archived ? "Restore" : "Archive"}
            </TooltipContent>
          </Tooltip>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {unread ? (
          <ContextMenuItem onClick={() => setUnread(false)}>
            <MailOpen aria-hidden="true" />
            Mark as read
          </ContextMenuItem>
        ) : (
          <ContextMenuItem
            disabled={!canMarkUnread}
            onClick={() => setUnread(true)}
          >
            <Mail aria-hidden="true" />
            Mark as unread
          </ContextMenuItem>
        )}
        {/* Archived rows restore before they pin, like the row buttons. */}
        {archived ? null : (
          <ContextMenuItem disabled={pin.isPending} onClick={togglePin}>
            <Pin aria-hidden="true" />
            {pinned ? "Unpin" : "Pin"}
          </ContextMenuItem>
        )}
        <ContextMenuItem onClick={() => setRenaming(true)}>
          <Pencil aria-hidden="true" />
          Rename
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={archive.isPending} onClick={toggleArchive}>
          {archived ? (
            <ArchiveRestore aria-hidden="true" />
          ) : (
            <Archive aria-hidden="true" />
          )}
          {archived ? "Restore" : "Archive"}
        </ContextMenuItem>
      </ContextMenuContent>
      {renaming ? (
        <RenameConversationDialog
          onClose={() => setRenaming(false)}
          onSave={(next) => rename.mutate(next)}
          title={title}
        />
      ) : null}
    </ContextMenu>
  );
});

/**
 * Show the row's secondary text: a lock when private, then the status when
 * the conversation runs, failed, or stopped, or else the age of its last
 * Message.
 */
function ConversationRowState(props: {
  conversation: Conversation;
  status: ReturnType<typeof visualStatusForConversation>;
}) {
  const isPrivate = props.conversation.visibility === "private";
  return (
    <span className="flex items-center gap-1">
      <ConversationStatusText isPrivate={isPrivate} status={props.status} />
      {props.status === "active" ? (
        <Spinner
          aria-label="Running"
          className="size-3.5 text-dashboard-text-muted"
        />
      ) : props.status === "failed" || props.status === "stopped" ? null : (
        <span className="font-sans text-xs tabular-nums text-dashboard-text-faint">
          {formatCompactAge(
            props.conversation.lastMessageAt ?? props.conversation.lastSeenAt,
          )}
        </span>
      )}
    </span>
  );
}
