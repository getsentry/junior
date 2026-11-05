import { useCallback, useEffect, useState } from "react";
import { Archive, ArchiveRestore } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router";

import {
  conversationDisplayTitle,
  formatRelativeTime,
  slackLocationLabel,
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
import { ConversationSidebarAnnotations } from "./ConversationMeta";
import { ConversationArchiveNotices } from "./ConversationArchiveNotices";
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
    <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-0.5 rounded-lg border border-dashboard-border-subtle bg-dashboard-fill-faint px-4 py-2.5 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto]">
      <Skeleton className="size-3 rounded-full" />
      <div className="flex h-6 min-w-0 items-center">
        <Skeleton
          className={cn(
            "h-3.5",
            props.index % 2 === 0 ? "w-56 max-w-4/5" : "w-44 max-w-3/5",
          )}
        />
      </div>
      <Skeleton className="hidden h-3 w-32 opacity-70 sm:block" />
      <div className="flex items-center gap-3">
        <Skeleton className="h-3 w-16 opacity-70" />
        <Skeleton className="size-4" />
      </div>
      <div className="col-span-full col-start-2 flex h-6 items-center">
        <Skeleton
          className={cn(
            "h-3 opacity-70",
            props.index % 2 === 0 ? "w-full max-w-2xl" : "w-2/3 max-w-xl",
          )}
        />
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
  const location = slackLocationLabel(conversation, { includeId: false });
  const participants = conversationParticipants(conversation);
  const isPrivate = conversation.visibility === "private";
  const prefetch = usePrefetchConversation(conversation.id);
  return (
    <article
      {...prefetch}
      // Status | title | metadata | time and archive on one line, then one
      // line of activity. On narrow screens the metadata moves below the
      // activity.
      className="group relative grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-0.5 rounded-lg border border-dashboard-border-subtle bg-dashboard-fill-faint px-4 py-2.5 transition-colors hover:border-dashboard-border hover:bg-dashboard-fill-soft sm:grid-cols-[auto_minmax(0,1fr)_auto_auto]"
      role="listitem"
    >
      <Link
        aria-label={`Open ${title}`}
        className="absolute inset-0 z-0 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-dashboard-focus"
        to={conversationPath(conversation.id)}
      />
      <span className="pointer-events-none relative z-[1] col-start-1 row-start-1 grid size-3 place-items-center">
        <ConversationListStatusIcon
          finishedSinceSeen={props.finishedSinceSeen}
          isPrivate={isPrivate}
          status={status}
          waitingOnViewer={props.waitingOnViewer}
        />
      </span>
      <h4 className="pointer-events-none relative z-[1] col-start-2 row-start-1 m-0 min-w-0 truncate font-display text-sm font-medium leading-6 text-dashboard-text">
        {title}
      </h4>
      <div className="pointer-events-none relative z-[1] col-span-2 col-start-2 row-start-3 flex h-6 min-w-0 items-center gap-x-1.5 overflow-hidden font-sans text-xs text-dashboard-text-muted empty:hidden sm:col-span-1 sm:col-start-3 sm:row-start-1 sm:max-w-96 sm:justify-end">
        {location ? (
          <span className="max-w-40 truncate">{location}</span>
        ) : null}
        {location && participants.length > 0 ? (
          <span aria-hidden="true">·</span>
        ) : null}
        {participants.length > 0 ? (
          <ParticipantAvatarStack participants={participants} size="list" />
        ) : null}
        <ConversationSidebarAnnotations
          annotations={conversation.sidebarAnnotations}
        />
      </div>
      <div className="relative z-[1] col-start-3 row-start-1 flex items-center gap-3 sm:col-start-4">
        <Link
          className="whitespace-nowrap font-sans text-xs tabular-nums text-dashboard-text-muted hover:text-dashboard-text focus:outline-none focus:ring-2 focus:ring-dashboard-focus"
          to={conversationPath(conversation.id)}
        >
          {formatRelativeTime(conversation.lastSeenAt)}
        </Link>
        <button
          aria-label={`${conversation.archivedAt ? "Restore" : "Archive"} ${title}`}
          className="relative shrink-0 cursor-pointer border-0 bg-transparent p-0 text-dashboard-text-muted transition before:absolute before:-inset-2 hover:text-dashboard-text focus:outline-none focus:ring-2 focus:ring-dashboard-focus focus:ring-offset-2 focus:ring-offset-dashboard-canvas disabled:cursor-not-allowed disabled:opacity-50"
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
            "pointer-events-none relative z-[1] col-span-full col-start-2 row-start-2 m-0 min-w-0 truncate font-sans text-sm leading-6",
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
    </article>
  );
}
