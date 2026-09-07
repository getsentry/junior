import { useCallback, useState } from "react";
import { Archive, ArchiveRestore, LockKeyhole } from "lucide-react";
import { Link } from "react-router";

import {
  conversationActorLabel,
  conversationDisplayTitle,
  formatRelativeTime,
  slackLocationLabel,
  visualStatusForConversation,
} from "../format";
import { ActiveIndicator } from "../components/ActiveIndicator";
import { EmptyTelemetry } from "../components/EmptyTelemetry";
import { Skeleton } from "../components/Skeleton";
import { cn } from "../styles";
import type { Conversation } from "../types";
import { ConversationSidebarAnnotations } from "./ConversationMeta";
import { formatConversationActivityPreview } from "./conversationActivityPreview";
import { ConversationArchiveNotices } from "./ConversationArchiveNotices";
import { conversationPath } from "./conversationRoutes";
import { useArchiveConversation } from "./queries";
import {
  buildConversationSections,
  type ConversationSection,
} from "./conversationSections";

/** Render grouped conversation cards on the dashboard home page. */
export function ConversationHomeList(props: {
  conversations: Conversation[];
  emptyLabel?: string;
  loading?: boolean;
  timeZone: string;
}) {
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
    nowMs: Date.now(),
    timeZone: props.timeZone,
  });
  return (
    <>
      <div aria-label="Your conversations" className="grid gap-5" role="list">
        {sections.map((section) => (
          <ConversationCardSection
            key={section.key}
            onArchiveError={handleArchiveError}
            onArchived={handleArchived}
            section={section}
          />
        ))}
      </div>
      {notices}
    </>
  );
}

/** Match the grouped card list while its first feed request is pending. */
export function ConversationHomeListLoading(props: { label: string }) {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className="grid gap-5"
      role="status"
    >
      <span className="sr-only">{props.label}</span>
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
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_max-content] gap-3 rounded-lg border border-dashboard-border-subtle bg-dashboard-fill-faint px-4 py-4 md:gap-5 md:px-5">
      <div className="flex min-w-0 items-start gap-2.5">
        <Skeleton className="mt-1.5 size-3 shrink-0 rounded-full" />
        <div className="grid min-w-0 flex-1 gap-2">
          <Skeleton
            className={cn(
              "h-4",
              props.index % 2 === 0 ? "w-56 max-w-4/5" : "w-44 max-w-3/5",
            )}
          />
          <div className="grid gap-1.5">
            <Skeleton className="h-3 w-full max-w-3xl opacity-70" />
            {props.index % 2 === 0 ? (
              <Skeleton className="h-3 w-2/3 max-w-xl opacity-70" />
            ) : null}
          </div>
          <Skeleton className="h-3 w-64 max-w-4/5 opacity-70" />
        </div>
      </div>
      <div className="flex items-start gap-2">
        <Skeleton className="h-3 w-16 opacity-70" />
        <Skeleton className="size-4" />
      </div>
    </div>
  );
}

function ConversationCardSection(props: {
  onArchiveError(conversation: Conversation, wasArchiving: boolean): void;
  onArchived(conversation: Conversation): void;
  section: ConversationSection;
}) {
  return (
    <section aria-labelledby={`conversation-section-${props.section.key}`}>
      <h3
        className="mb-2 mt-0 px-1 font-display text-xs font-semibold uppercase tracking-[0.08em] text-dashboard-text-muted"
        id={`conversation-section-${props.section.key}`}
      >
        {props.section.label}
      </h3>
      <div className="grid gap-2">
        {props.section.conversations.map((conversation) => (
          <ConversationCard
            conversation={conversation}
            key={conversation.id}
            onArchiveError={props.onArchiveError}
            onArchived={props.onArchived}
          />
        ))}
      </div>
    </section>
  );
}

function ConversationCard(props: {
  conversation: Conversation;
  onArchiveError(conversation: Conversation, wasArchiving: boolean): void;
  onArchived(conversation: Conversation): void;
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
  const actor = conversationActorLabel(conversation);
  const isPrivate = conversation.visibility === "private";
  return (
    <article
      className="group relative grid min-w-0 grid-cols-[minmax(0,1fr)_max-content] gap-3 rounded-lg border border-dashboard-border-subtle bg-dashboard-fill-faint px-4 py-4 transition-colors hover:border-dashboard-border hover:bg-dashboard-fill-soft md:gap-5 md:px-5"
      role="listitem"
    >
      <Link
        aria-label={`Open ${title}`}
        className="absolute inset-0 z-0 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-dashboard-focus"
        to={conversationPath(conversation.id)}
      />
      <div className="relative z-[1] flex min-w-0 items-start gap-2.5 pointer-events-none">
        <span className="mt-1.5 grid size-3 shrink-0 place-items-center">
          {isPrivate ? (
            <LockKeyhole
              aria-label="Private conversation"
              className="size-3 text-dashboard-text-muted"
            />
          ) : status === "active" ? (
            <ActiveIndicator className="size-1.5" />
          ) : (
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 rounded-full",
                status === "failed"
                  ? "bg-rose-300"
                  : "bg-dashboard-text-muted/40",
              )}
            />
          )}
        </span>
        <div className="grid min-w-0 flex-1 gap-2">
          <h4 className="m-0 truncate font-display text-base font-medium leading-snug text-dashboard-text">
            {title}
          </h4>
          {conversation.activityPreview ? (
            <p className="m-0 line-clamp-2 font-sans text-sm leading-relaxed text-dashboard-text-subtle">
              {formatConversationActivityPreview(
                conversation.activityPreview.text,
              )}
            </p>
          ) : (
            <p className="m-0 font-sans text-sm leading-relaxed text-dashboard-text-muted">
              {status === "active" ? "Working…" : "No recent message"}
            </p>
          )}
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 font-mono text-xs text-dashboard-text-muted">
            {location ? <span className="truncate">{location}</span> : null}
            {location && actor ? <span aria-hidden="true">·</span> : null}
            {actor ? <span className="truncate">{actor}</span> : null}
            <ConversationSidebarAnnotations
              annotations={conversation.sidebarAnnotations}
            />
          </div>
        </div>
      </div>
      <div className="pointer-events-none relative z-[1] flex items-start gap-2">
        <Link
          className="pointer-events-auto whitespace-nowrap font-mono text-xs text-dashboard-text-muted hover:text-dashboard-text focus:outline-none focus:ring-2 focus:ring-dashboard-focus"
          to={conversationPath(conversation.id)}
        >
          {formatRelativeTime(conversation.lastSeenAt)}
        </Link>
        <button
          aria-label={`${conversation.archivedAt ? "Restore" : "Archive"} ${title}`}
          className="pointer-events-auto relative shrink-0 cursor-pointer border-0 bg-transparent p-0 text-dashboard-text-muted transition before:absolute before:-inset-2 hover:text-dashboard-text focus:outline-none focus:ring-2 focus:ring-dashboard-focus focus:ring-offset-2 focus:ring-offset-dashboard-canvas disabled:cursor-not-allowed disabled:opacity-50"
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
    </article>
  );
}
