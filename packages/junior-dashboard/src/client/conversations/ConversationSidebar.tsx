import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { Archive, ArchiveRestore, Pin, SquarePen } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";

import { useArchiveConversation } from "./conversationArchive";
import { useConversationActionToasts } from "./conversationActionToasts";
import { usePinConversation } from "./usePinConversation";
import { useRenameConversation } from "./useRenameConversation";
import { RenameConversationDialog } from "./RenameConversationDialog";
import { useConversationDelivery } from "./useConversationDelivery";
import { useConversationSubscription } from "./useConversationSubscription";
import { ContinueInSlackDialog } from "./ContinueInSlackDialog";
import { ConversationRowMenu } from "./ConversationRowMenu";
import {
  usePinnedRowDrag,
  type PinnedRowDrag,
} from "./PinnedConversationOrder";
import type { ReorderPins } from "./useReorderPinnedConversations";
import { conversationPath, OPEN_EVENT_LOG_STATE } from "./conversationRoutes";
import {
  conversationDisplayTitle,
  visualStatusForConversation,
} from "../format";
import { formatCompactAge } from "./conversationAge";
import { cn } from "../styles";
import type { Conversation } from "../types";
import { AnimatedList } from "./AnimatedList";
import { WaitingChip } from "./WaitingChip";
import type { ConversationSection } from "./conversationSections";
import { ConversationSectionList } from "./ConversationSectionList";
import { ConversationStatusText } from "./ConversationListStatusIcon";
import { ConversationSectionHeading } from "./ConversationSectionHeading";
import {
  ConversationSidebarThreadRow,
  ConversationSidebarThreadToggle,
} from "./ConversationSidebarThreadRow";
import { sidebarThreads } from "./sidebarThreads";
import {
  ROW_ACTION_BUTTON_CLASS,
  ROW_ACTIONS_FADE_CLASS,
  ROW_ACTIONS_REVEAL_CLASS,
} from "./sidebarRowActions";
import {
  prefetchConversationDetail,
  usePrefetchConversation,
} from "./conversationPrefetch";
import { useCollapsedConversationSections } from "./useCollapsedConversationSections";
import { EmptyTelemetry } from "../components/EmptyTelemetry";
import {
  ContextMenu,
  ContextMenuContent,
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
  | { conversation: Conversation; key: string; kind: "conversation" }
  | { conversation: Conversation; depth: number; key: string; kind: "thread" }
  | {
      expanded: boolean;
      hiddenCount: number;
      key: string;
      kind: "thread-toggle";
      rootId: string;
    };

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
          variant="ghost"
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
      {/* The list wraps the always-shown scroll area, so a pointer that
          rests on it through the first load, or on its padding or
          scrollbar, still holds the order. */}
      <ConversationSectionList
        className="relative min-h-0"
        conversations={props.conversations}
        loading={props.loading}
        onReorderError={handleReorderError}
        onReorderPins={props.onReorderPins}
        timeZone={props.timeZone}
        waitingConversations={props.waitingConversations}
      >
        {({ releaseHold, sections }) => (
          <ScrollArea
            className="h-full"
            viewportClassName="px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
          >
            {props.error ? (
              <div className="p-2">
                <EmptyTelemetry>{props.error}</EmptyTelemetry>
              </div>
            ) : props.loading && props.conversations.length === 0 ? (
              <ConversationRowsLoading />
            ) : (
              <ConversationSidebarEntries
                collapsedKeys={collapsedKeys}
                expandedThreadRoots={expandedThreadRoots}
                loading={props.loading}
                sections={sections}
                selectedId={props.selectedId}
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
                      onArchiveError={showArchiveError}
                      onArchived={showArchived}
                      onRowAction={releaseHold}
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
                      onActionError={showActionError}
                      onRowAction={releaseHold}
                      selected={entry.conversation.id === props.selectedId}
                      waiting={props.waitingConversations.get(
                        entry.conversation.id,
                      )}
                    />
                  )
                }
              />
            )}
          </ScrollArea>
        )}
      </ConversationSectionList>
    </aside>
  );
}

/** Show the sidebar rows of the held sections, with their motion. */
function ConversationSidebarEntries(props: {
  collapsedKeys: ReadonlySet<string>;
  expandedThreadRoots: ReadonlySet<string>;
  loading: boolean;
  renderItem(entry: ConversationSidebarEntry): ReactNode;
  sections: ConversationSection[];
  selectedId?: string;
}) {
  const { collapsedKeys, expandedThreadRoots, sections, selectedId } = props;
  const entries = useMemo(
    () =>
      conversationSidebarEntries(sections, collapsedKeys, {
        expandedThreadRoots,
        selectedId,
      }),
    [collapsedKeys, expandedThreadRoots, sections, selectedId],
  );
  return (
    <AnimatedList
      ariaLabel="Your conversations"
      className="grid gap-0.5"
      empty={
        !props.loading ? (
          <div className="p-2">
            <EmptyTelemetry>No conversations match this view.</EmptyTelemetry>
          </div>
        ) : undefined
      }
      getKey={conversationEntryKey}
      items={entries}
      renderItem={props.renderItem}
      role="navigation"
    />
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
  onActionError(conversation: Conversation, title: string): void;
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
  const rename = useRenameConversation(props.conversation.id, {
    onError: () => props.onActionError(props.conversation, "Could not rename"),
  });
  const subscription = useConversationSubscription(props.conversation.id, {
    onError: () =>
      props.onActionError(props.conversation, "Could not update subscription"),
  });
  const delivery = useConversationDelivery(props.conversation.id, {
    onError: () =>
      props.onActionError(props.conversation, "Could not change Slack updates"),
  });
  const [renaming, setRenaming] = useState(false);
  const [continueInSlackOpen, setContinueInSlackOpen] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const prefetch = usePrefetchConversation(props.conversation.id);
  const pinned = Boolean(props.conversation.pinnedAt);
  const status = visualStatusForConversation(props.conversation);
  const title = conversationDisplayTitle(props.conversation);
  const drag = props.drag;
  const archived = Boolean(props.conversation.archivedAt);
  // The API takes row actions only from participants.
  const participant = props.conversation.isParticipant;
  const setPinned = (next: boolean) => {
    props.onRowAction();
    pin.mutate(next);
  };
  const togglePin = () => setPinned(!pinned);
  const toggleArchive = () => {
    props.onRowAction();
    archive.mutate({
      archived: !archived,
      lastSeenAt: props.conversation.lastSeenAt,
    });
  };
  return (
    <ContextMenu
      // The menu shows rows from the detail, so read it as a hover does.
      onOpenChange={(open) => {
        if (open)
          void prefetchConversationDetail(queryClient, props.conversation.id);
      }}
    >
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
            "grid min-w-0 grid-cols-[0.875rem_minmax(0,1fr)_auto] items-center gap-x-2 rounded-lg px-3 py-1.5 text-inherit no-underline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus",
            participant && `max-sm:pr-10 ${ROW_ACTIONS_FADE_CLASS}`,
            // A long press opens the row menu or drags a pin, not the iOS
            // link callout.
            "[-webkit-touch-callout:none]",
          )}
          // The browser's own link drag would take the pointer from the reorder.
          draggable={drag ? false : undefined}
          to={conversationPath(props.conversation.id)}
        >
          <span className="grid place-items-center">
            {props.waiting ? (
              <span
                aria-label="Waiting on you"
                className="size-1.5 shrink-0 rounded-full bg-dashboard-accent"
                role="img"
              />
            ) : null}
          </span>
          {/* The title fills its grid column, so the fade reaches only a
            title that does not fit, in place of an ellipsis. */}
          <span className="min-w-0 overflow-hidden whitespace-nowrap font-sans text-sm leading-snug text-dashboard-text [mask-image:linear-gradient(to_left,transparent,black_2rem)]">
            {title}
          </span>
          <ConversationRowState
            conversation={props.conversation}
            status={status}
          />
        </Link>
        {props.waiting ? (
          <WaitingChip
            conversationId={props.conversation.id}
            waiting={props.waiting}
          />
        ) : null}
        {/* Mobile rows pin from the conversation menu, so only the archive
          button takes row space there. Archived rows restore before they pin. */}
        {participant ? (
          <div
            className={cn(
              "absolute top-0.5 right-1.5",
              ROW_ACTIONS_REVEAL_CLASS,
            )}
          >
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
        ) : null}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ConversationRowMenu
          actions={{
            archive: toggleArchive,
            continueInSlack: () => setContinueInSlackOpen(true),
            delivery: (paused) => delivery.mutate(paused),
            // The page keeps its view in state, not in history. An open
            // page replaces its entry, so Back does not land on the same
            // page in the event log.
            eventLog: () =>
              navigate(conversationPath(props.conversation.id), {
                replace: props.selected,
                state: OPEN_EVENT_LOG_STATE,
              }),
            pin: setPinned,
            rename: () => setRenaming(true),
            subscription: (subscribed) => subscription.mutate(subscribed),
          }}
          conversation={props.conversation}
          conversationId={props.conversation.id}
          pending={{
            archive: archive.isPending,
            delivery: delivery.isPending,
            pin: pin.isPending,
            subscription: subscription.isPending,
          }}
        />
      </ContextMenuContent>
      {renaming ? (
        <RenameConversationDialog
          onClose={() => setRenaming(false)}
          onSave={(next) => rename.mutate(next)}
          title={title}
        />
      ) : null}
      {continueInSlackOpen ? (
        <ContinueInSlackDialog
          conversationId={props.conversation.id}
          onClose={() => setContinueInSlackOpen(false)}
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
