import { useCallback, useEffect, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  LockKeyhole,
  MessageSquare,
} from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router";

import {
  conversationDisplayTitle,
  formatTime,
  visualStatusForConversation,
} from "../format";
import { EmptyTelemetry } from "../components/EmptyTelemetry";
import { Skeleton } from "../components/ui/skeleton";
import {
  conversationParticipants,
  ParticipantAvatarStack,
} from "../components/ParticipantAvatarStack";
import { cn } from "../styles";
import type { Conversation } from "../types";
import { ConversationArchiveNotices } from "./ConversationArchiveNotices";
import { formatActivityDay } from "./conversationAge";
import { conversationCardTags } from "./ConversationContextTags";
import { ConversationListStatusIcon } from "./ConversationListStatusIcon";
import { conversationPath } from "./conversationRoutes";
import {
  useArchiveConversation,
  useLatestArchiveStatus,
  type ArchivedFromConversationState,
} from "./conversationArchive";
import { DisplayText } from "../display-text/DisplayText";
import {
  attentionConversationIds,
  buildConversationSections,
  type ConversationSection,
} from "./conversationSections";
import { ConversationSectionHeading } from "./ConversationSectionHeading";
import { usePrefetchConversation } from "./conversationPrefetch";
import { useCollapsedConversationSections } from "./useCollapsedConversationSections";

/** Render grouped conversation cards on the dashboard home page. */
export function ConversationHomeList(props: {
  conversations: Conversation[];
  emptyLabel?: string;
  finishedConversationIds: ReadonlySet<string>;
  loading?: boolean;
  timeZone: string;
  waitingConversationIds: ReadonlySet<string>;
}) {
  const { collapsedKeys, toggle: toggleSection } =
    useCollapsedConversationSections();
  const [archivedConversation, setArchivedConversation] =
    useState<Conversation>();
  const [archiveError, setArchiveError] = useState<{
    conversation: Conversation;
    wasArchiving: boolean;
  }>();
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
  useConversationPageArchiveResult(handleArchived, handleArchiveError);
  const notices = (
    <ConversationArchiveNotices
      archivedConversation={archivedConversation}
      archiveError={archiveError}
      className="fixed bottom-[max(0.75rem,env(safe-area-inset-bottom))] left-3 right-3 z-30 sm:left-auto sm:w-96"
      onDismissError={() => setArchiveError(undefined)}
      onRestored={() => setArchivedConversation(undefined)}
    />
  );

  if (props.loading && props.conversations.length === 0) {
    return <ConversationHomeListLoading label="Loading conversations" />;
  }

  if (props.conversations.length === 0) {
    return (
      <>
        <div className="rounded-lg border border-dashboard-border-subtle bg-dashboard-fill-faint p-4">
          <EmptyTelemetry>
            {props.emptyLabel ?? "No conversations match this view."}
          </EmptyTelemetry>
        </div>
        {notices}
      </>
    );
  }

  const sections = buildConversationSections(props.conversations, {
    attentionIds: attentionConversationIds(
      props.waitingConversationIds,
      props.finishedConversationIds,
    ),
    nowMs: Date.now(),
    timeZone: props.timeZone,
  });
  return (
    <>
      <div aria-label="Your conversations" className="grid gap-4" role="list">
        {sections.map((section) => (
          <ConversationCardSection
            collapsed={collapsedKeys.has(section.key)}
            finishedConversationIds={props.finishedConversationIds}
            key={section.key}
            onArchiveError={handleArchiveError}
            onArchived={handleArchived}
            onToggle={() => toggleSection(section.key)}
            waitingConversationIds={props.waitingConversationIds}
            section={section}
          />
        ))}
      </div>
      {notices}
    </>
  );
}

/**
 * Report an archive started on the conversation page, which navigated home
 * before the request finished.
 */
function useConversationPageArchiveResult(
  onArchived: (conversation: Conversation) => void,
  onArchiveError: (conversation: Conversation, wasArchiving: boolean) => void,
) {
  const location = useLocation();
  const navigate = useNavigate();
  const conversation = (location.state as ArchivedFromConversationState | null)
    ?.archivedConversation;
  const status = useLatestArchiveStatus(conversation?.id);
  useEffect(() => {
    if (!conversation || (status !== "success" && status !== "error")) return;
    if (status === "success") onArchived(conversation);
    else onArchiveError(conversation, true);
    // Clear the state so a reload or a later restore does not report again.
    navigate(
      { hash: location.hash, search: location.search },
      { replace: true, state: null },
    );
  }, [
    conversation,
    location.hash,
    location.search,
    navigate,
    onArchiveError,
    onArchived,
    status,
  ]);
}

/** Match the grouped card list while its first feed request is pending. */
export function ConversationHomeListLoading(props: { label?: string }) {
  return (
    <div
      aria-busy={props.label ? "true" : undefined}
      aria-live={props.label ? "polite" : undefined}
      className="grid gap-4"
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
          <div className="grid gap-1.5">
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
  finishedConversationIds: ReadonlySet<string>;
  onArchiveError(conversation: Conversation, wasArchiving: boolean): void;
  onArchived(conversation: Conversation): void;
  onToggle(): void;
  section: ConversationSection;
  waitingConversationIds: ReadonlySet<string>;
}) {
  return (
    <section aria-labelledby={`conversation-section-${props.section.key}`}>
      <ConversationSectionHeading
        className={cn("px-1", !props.collapsed && "mb-2")}
        collapsed={props.collapsed}
        count={props.section.conversations.length}
        id={`conversation-section-${props.section.key}`}
        label={props.section.label}
        onToggle={props.onToggle}
      />
      {props.collapsed ? null : (
        <div className="grid gap-1.5">
          {props.section.conversations.map((conversation) => (
            <ConversationCard
              conversation={conversation}
              finishedSinceSeen={props.finishedConversationIds.has(
                conversation.id,
              )}
              key={conversation.id}
              onArchiveError={props.onArchiveError}
              onArchived={props.onArchived}
              waitingOnViewer={props.waitingConversationIds.has(
                conversation.id,
              )}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ConversationCard(props: {
  conversation: Conversation;
  finishedSinceSeen: boolean;
  onArchiveError(conversation: Conversation, wasArchiving: boolean): void;
  onArchived(conversation: Conversation): void;
  waitingOnViewer: boolean;
}) {
  const conversation = props.conversation;
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
  // Idle conversations get no badge, so the badges that show stand out.
  const showStatus =
    props.waitingOnViewer ||
    props.finishedSinceSeen ||
    status === "active" ||
    status === "failed";
  return (
    <article
      {...prefetch}
      className="group relative grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 rounded-lg border border-dashboard-border-subtle bg-dashboard-fill-faint px-3 py-2.5 transition-colors hover:border-dashboard-border hover:bg-dashboard-fill-soft sm:px-4"
      role="listitem"
    >
      <Link
        aria-label={`Open ${title}`}
        className="absolute inset-0 z-0 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-dashboard-focus"
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
              finishedSinceSeen={props.finishedSinceSeen}
              isPrivate={false}
              status={status}
              waitingOnViewer={props.waitingOnViewer}
            />
          </span>
        ) : null}
      </span>
      <div className="grid min-w-0">
        <div className="flex min-w-0 items-center gap-3">
          <h4 className="pointer-events-none relative z-[1] m-0 min-w-0 flex-1 truncate font-display text-sm font-medium leading-6 text-dashboard-text">
            {title}
          </h4>
          {participants.length > 0 ? (
            <span className="pointer-events-none relative z-[1] hidden sm:inline-flex">
              <ParticipantAvatarStack participants={participants} size="list" />
            </span>
          ) : null}
          <time
            className="pointer-events-none relative z-[1] min-w-14 whitespace-nowrap text-right font-sans text-xs tabular-nums text-dashboard-text-muted"
            dateTime={conversation.lastSeenAt}
            title={formatTime(conversation.lastSeenAt, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          >
            {formatActivityDay(conversation.lastSeenAt)}
          </time>
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
