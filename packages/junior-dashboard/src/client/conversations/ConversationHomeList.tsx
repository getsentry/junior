import { useCallback } from "react";
import {
  Archive,
  ArchiveRestore,
  LockKeyhole,
  MessageSquare,
} from "lucide-react";
import { Link } from "react-router";

import {
  conversationDisplayTitle,
  formatTime,
  visualStatusForConversation,
} from "../format";
import { EmptyTelemetry } from "../components/EmptyTelemetry";
import { Skeleton } from "../components/ui/skeleton";
import { Spinner } from "../components/ui/spinner";
import {
  conversationParticipants,
  ParticipantAvatarStack,
} from "../components/ParticipantAvatarStack";
import { cn } from "../styles";
import type { WaitingConversation } from "../review-desk/queries";
import type { Conversation } from "../types";
import { useConversationActionToasts } from "./conversationActionToasts";
import { formatActivityDay } from "./conversationAge";
import { conversationCardTags } from "./ConversationContextTags";
import {
  ConversationListStatusIcon,
  ConversationStatusText,
} from "./ConversationListStatusIcon";
import { conversationPath } from "./conversationRoutes";
import { useArchiveConversation } from "./conversationArchive";
import { DisplayText } from "../display-text/DisplayText";
import {
  buildConversationSections,
  type ConversationSection,
} from "./conversationSections";
import { ConversationSectionHeading } from "./ConversationSectionHeading";
import { usePrefetchConversation } from "./conversationPrefetch";
import { useCollapsedConversationSections } from "./useCollapsedConversationSections";
import {
  PinnedConversationOrder,
  usePinnedRowDrag,
  type PinnedRowDrag,
} from "./PinnedConversationOrder";
import type { ReorderPins } from "./useReorderPinnedConversations";

/** Render grouped conversation cards on the dashboard home page. */
export function ConversationHomeList(props: {
  conversations: Conversation[];
  emptyLabel?: string;
  loading?: boolean;
  /** Leave unset when the list shows only some pins. */
  onReorderPins?: ReorderPins;
  timeZone: string;
  waitingConversations: ReadonlyMap<string, WaitingConversation>;
}) {
  const { collapsedKeys, toggle: toggleSection } =
    useCollapsedConversationSections();
  const { showActionError, showArchiveError, showArchived } =
    useConversationActionToasts();
  const handleReorderError = useCallback(
    (conversation: Conversation) =>
      showActionError(conversation, "Could not reorder"),
    [showActionError],
  );

  if (props.loading && props.conversations.length === 0) {
    return <ConversationHomeListLoading label="Loading conversations" />;
  }

  if (props.conversations.length === 0) {
    return (
      <div className="rounded-lg border border-dashboard-border-subtle bg-dashboard-fill-faint p-4">
        <EmptyTelemetry>
          {props.emptyLabel ?? "No conversations match this view."}
        </EmptyTelemetry>
      </div>
    );
  }

  const sections = buildConversationSections(props.conversations, {
    nowMs: Date.now(),
    timeZone: props.timeZone,
    waiting: props.waitingConversations,
  });
  const pinnedSection = sections.find((section) => section.key === "pinned");
  return (
    <PinnedConversationOrder
      conversations={pinnedSection?.conversations ?? []}
      onError={handleReorderError}
      reorder={props.onReorderPins}
    >
      <div aria-label="Your conversations" className="grid gap-5" role="list">
        {sections.map((section) => (
          <ConversationCardSection
            collapsed={collapsedKeys.has(section.key)}
            key={section.key}
            onArchiveError={showArchiveError}
            onArchived={showArchived}
            onToggle={() => toggleSection(section.key)}
            waitingConversations={props.waitingConversations}
            section={section}
          />
        ))}
      </div>
    </PinnedConversationOrder>
  );
}

/** Match the grouped card list while its first feed request is pending. */
export function ConversationHomeListLoading(props: { label?: string }) {
  return (
    <div
      aria-busy={props.label ? "true" : undefined}
      aria-live={props.label ? "polite" : undefined}
      className="grid gap-5"
      role={props.label ? "status" : undefined}
    >
      {props.label ? <span className="sr-only">{props.label}</span> : null}
      {[3, 2].map((count, sectionIndex) => (
        <div key={count}>
          <Skeleton
            className={cn(
              "mb-2 ml-1 h-3",
              sectionIndex === 0 ? "w-16" : "w-12",
            )}
          />
          <div className="grid gap-2">
            {Array.from({ length: count }, (_, index) => (
              <ConversationCardLoading
                index={index + sectionIndex * 3}
                key={index}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ConversationCardLoading(props: { index: number }) {
  return (
    <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 rounded-lg border border-dashboard-border-subtle bg-dashboard-fill-faint px-3 py-2.5 sm:px-4">
      <Skeleton className="mt-0.5 size-8 rounded-md" />
      <div className="grid min-w-0">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-6 min-w-0 flex-1 items-center">
            <Skeleton
              className={cn(
                "h-3.5",
                props.index % 2 === 0 ? "w-56 max-w-4/5" : "w-44 max-w-3/5",
              )}
            />
          </div>
          <Skeleton className="h-3 w-14 opacity-70" />
          <Skeleton className="size-4" />
        </div>
        <div className="flex h-5 min-w-0 items-center">
          <Skeleton
            className={cn(
              "h-3 opacity-70",
              props.index % 2 === 0 ? "w-full max-w-xl" : "w-1/2 max-w-md",
            )}
          />
        </div>
        <Skeleton className="mt-1 h-6 w-28 rounded-md opacity-70" />
      </div>
    </div>
  );
}

function ConversationCardSection(props: {
  collapsed: boolean;
  onArchiveError(conversation: Conversation, wasArchiving: boolean): void;
  onArchived(conversation: Conversation): void;
  onToggle(): void;
  section: ConversationSection;
  waitingConversations: ReadonlyMap<string, WaitingConversation>;
}) {
  return (
    <section aria-labelledby={`conversation-section-${props.section.key}`}>
      <ConversationSectionHeading
        // The label stays at the top while its cards scroll under it, like a
        // native grouped list. The fill covers the cards that pass below.
        className={cn(
          "sticky top-0 z-10 -mx-1 bg-dashboard-bg px-2 py-1.5",
          !props.collapsed && "mb-0.5",
        )}
        collapsed={props.collapsed}
        count={props.section.conversations.length}
        id={`conversation-section-${props.section.key}`}
        label={props.section.label}
        onToggle={props.onToggle}
      />
      {props.collapsed ? null : (
        <div className="grid gap-2">
          {props.section.conversations.map((conversation) => {
            const card = {
              conversation,
              onArchiveError: props.onArchiveError,
              onArchived: props.onArchived,
              waitingOnViewer: props.waitingConversations.has(conversation.id),
            };
            return conversation.pinnedAt ? (
              <PinnedConversationCard {...card} key={conversation.id} />
            ) : (
              <ConversationCard {...card} key={conversation.id} />
            );
          })}
        </div>
      )}
    </section>
  );
}

type ConversationCardProps = {
  conversation: Conversation;
  /** Set on pinned cards, which drag to reorder. */
  drag?: PinnedRowDrag;
  onArchiveError(conversation: Conversation, wasArchiving: boolean): void;
  onArchived(conversation: Conversation): void;
  waitingOnViewer: boolean;
};

function PinnedConversationCard(props: Omit<ConversationCardProps, "drag">) {
  const drag = usePinnedRowDrag(props.conversation.id);
  return <ConversationCard {...props} drag={drag} />;
}

function ConversationCard(props: ConversationCardProps) {
  const conversation = props.conversation;
  const drag = props.drag;
  const archive = useArchiveConversation(conversation.id, {
    onError: () =>
      props.onArchiveError(conversation, archive.variables?.archived ?? true),
    onSuccess: (archived) => {
      if (archived) props.onArchived(conversation);
    },
  });
  const status = visualStatusForConversation(conversation);
  const title = conversationDisplayTitle(conversation);
  const participants = conversationParticipants(conversation);
  const isPrivate = conversation.visibility === "private";
  const tags = conversationCardTags(conversation, title);
  const prefetch = usePrefetchConversation(conversation.id);
  const VisibilityIcon = isPrivate ? LockKeyhole : MessageSquare;
  const unread = Boolean(conversation.unread);
  const emphasized = props.waitingOnViewer || unread;
  // Only read state and a running Turn get a badge. Failed and stopped are
  // secondary text beside the time.
  const showStatus = emphasized || status === "active";
  const activityAt = conversation.lastMessageAt ?? conversation.lastSeenAt;
  return (
    <article
      {...prefetch}
      {...drag?.listeners}
      className={cn(
        "group relative grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 rounded-lg border border-dashboard-border-subtle bg-dashboard-fill-faint px-3 py-2.5 transition-[background-color,border-color,scale] duration-100 ease-out hover:border-dashboard-border hover:bg-dashboard-fill-soft has-[>a:active]:scale-[0.99] has-[>a:active]:bg-dashboard-fill-soft motion-reduce:has-[>a:active]:scale-100 sm:px-4",
        drag?.dragging && "opacity-40",
      )}
      onKeyDown={drag?.onKeyDown}
      ref={drag?.setNodeRef}
      role="listitem"
    >
      <Link
        aria-keyshortcuts={drag ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
        aria-label={`Open ${title}`}
        className={cn(
          "absolute inset-0 z-0 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-dashboard-focus",
          // A long press drags the card instead of opening the link menu.
          drag && "[-webkit-touch-callout:none]",
        )}
        // The browser's own link drag would take the pointer from the reorder.
        draggable={drag ? false : undefined}
        to={conversationPath(conversation.id)}
      />
      <span className="pointer-events-none relative z-[1] mt-0.5 grid size-8 place-items-center rounded-md border border-dashboard-border-subtle bg-dashboard-surface-panel text-dashboard-text-muted">
        <VisibilityIcon
          aria-label={
            isPrivate ? "Private conversation" : "Public conversation"
          }
          role="img"
          size={15}
        />
        {showStatus ? (
          <span className="absolute -bottom-1 -right-1 grid size-3.5 place-items-center rounded-full bg-dashboard-surface-panel">
            <ConversationListStatusIcon
              status={status}
              unread={unread}
              waitingOnViewer={props.waitingOnViewer}
            />
          </span>
        ) : null}
      </span>
      <div className="grid min-w-0">
        <div className="flex min-w-0 items-center gap-3">
          <h4
            className={cn(
              "pointer-events-none relative z-[1] m-0 min-w-0 flex-1 truncate font-display text-sm leading-6 text-dashboard-text",
              emphasized ? "font-semibold" : "font-medium",
            )}
          >
            {title}
          </h4>
          {participants.length > 0 ? (
            <span className="pointer-events-none relative z-[1] hidden sm:inline-flex">
              <ParticipantAvatarStack participants={participants} size="list" />
            </span>
          ) : null}
          {status === "active" ? (
            // Like the sidebar row: a running row shows that it runs, not
            // when its last Event came, so the feed token can skip it.
            <span className="pointer-events-none relative z-[1] flex min-w-14 justify-end">
              <Spinner
                aria-label="Running"
                className="size-3.5 text-dashboard-text-muted"
              />
            </span>
          ) : (
            <>
              <span className="pointer-events-none relative z-[1]">
                {/* The tile already shows the lock. */}
                <ConversationStatusText isPrivate={false} status={status} />
              </span>
              <time
                className="pointer-events-none relative z-[1] min-w-14 whitespace-nowrap text-right font-sans text-xs tabular-nums text-dashboard-text-muted"
                dateTime={activityAt}
                title={formatTime(activityAt, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              >
                {formatActivityDay(activityAt)}
              </time>
            </>
          )}
          <button
            aria-label={`${conversation.archivedAt ? "Restore" : "Archive"} ${title}`}
            className="relative z-[1] shrink-0 cursor-pointer border-0 bg-transparent p-0 text-dashboard-text-muted transition before:absolute before:-inset-2 hover:text-dashboard-text focus:outline-none focus:ring-2 focus:ring-dashboard-focus focus:ring-offset-2 focus:ring-offset-dashboard-canvas disabled:cursor-not-allowed disabled:opacity-50"
            disabled={archive.isPending}
            onClick={() =>
              archive.mutate({
                archived: !conversation.archivedAt,
                lastSeenAt: conversation.lastSeenAt,
              })
            }
            type="button"
          >
            {conversation.archivedAt ? (
              <ArchiveRestore aria-hidden="true" size={15} />
            ) : (
              <Archive aria-hidden="true" size={15} />
            )}
          </button>
        </div>
        {conversation.activityPreview || status === "active" ? (
          <p
            className={cn(
              "pointer-events-none relative z-[1] m-0 min-w-0 truncate font-sans text-sm leading-5",
              conversation.activityPreview
                ? "text-dashboard-text-subtle"
                : "text-dashboard-text-muted",
            )}
          >
            {conversation.activityPreview ? (
              <DisplayText
                inline
                mentions={conversation.activityPreview.mentions}
                text={conversation.activityPreview.text}
              />
            ) : (
              "Working…"
            )}
          </p>
        ) : null}
        {tags ? (
          // Only the tag links take clicks. The gaps open the card.
          <div className="pointer-events-none relative z-[1] mt-1 min-w-0 overflow-hidden [&_a]:pointer-events-auto">
            {tags}
          </div>
        ) : null}
      </div>
    </article>
  );
}
