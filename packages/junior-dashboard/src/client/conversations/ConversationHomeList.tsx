import { useState } from "react";
import { Archive, ArchiveRestore, LockKeyhole } from "lucide-react";
import { Link } from "react-router";

import {
  conversationActorLabel,
  conversationDisplayTitle,
  formatConversationCostTotal,
  formatRelativeTime,
  formatRuntime,
  formatUsageTotal,
  slackLocationLabel,
  visualStatusForConversation,
} from "../format";
import { ActiveIndicator } from "../components/ActiveIndicator";
import { EmptyTelemetry } from "../components/EmptyTelemetry";
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
  timeZone: string;
}) {
  const [archivedConversation, setArchivedConversation] =
    useState<Conversation>();
  const [archiveError, setArchiveError] = useState<Conversation>();
  const notices = (
    <ConversationArchiveNotices
      archivedConversation={archivedConversation}
      archiveError={archiveError}
      className="fixed bottom-[max(0.75rem,env(safe-area-inset-bottom))] left-3 right-3 z-30 sm:left-auto sm:w-96"
      onDismissError={() => setArchiveError(undefined)}
      onRestored={() => setArchivedConversation(undefined)}
    />
  );

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
            onArchiveError={setArchiveError}
            onArchived={setArchivedConversation}
            section={section}
          />
        ))}
      </div>
      {notices}
    </>
  );
}

function ConversationCardSection(props: {
  onArchiveError(conversation: Conversation): void;
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
  onArchiveError(conversation: Conversation): void;
  onArchived(conversation: Conversation): void;
}) {
  const conversation = props.conversation;
  const archive = useArchiveConversation(conversation.id, {
    onError: () => props.onArchiveError(conversation),
    onSuccess: (archived) => {
      if (archived) props.onArchived(conversation);
    },
  });
  const status = visualStatusForConversation(conversation);
  const title = conversationDisplayTitle(conversation);
  const location = slackLocationLabel(conversation, { includeId: false });
  const actor = conversationActorLabel(conversation);
  const tokens = formatUsageTotal(conversation.cumulativeUsage);
  const cost = formatConversationCostTotal(
    conversation.cumulativeUsage,
    conversation.auxiliaryCosts,
  );
  const runtime = formatRuntime(conversation.cumulativeDurationMs);
  const isPrivate = conversation.visibility === "private";
  return (
    <article
      className="group relative grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-4 rounded-lg border border-dashboard-border-subtle bg-dashboard-fill-faint px-4 py-4 transition-colors hover:border-dashboard-border hover:bg-dashboard-fill-soft md:grid-cols-[minmax(0,1fr)_12rem_2.75rem] md:items-center md:gap-5 md:px-5"
      role="listitem"
    >
      <Link
        aria-label={`Open ${title}`}
        className="absolute inset-0 z-0 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-dashboard-focus"
        to={conversationPath(conversation.id)}
      />
      <div className="relative z-[1] col-span-2 flex min-w-0 items-start gap-2.5 pointer-events-none md:col-span-1">
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
            <p className="m-0 line-clamp-2 min-h-10 font-sans text-sm leading-relaxed text-dashboard-text-subtle">
              {formatConversationActivityPreview(
                conversation.activityPreview.text,
              )}
            </p>
          ) : (
            <p className="m-0 min-h-10 font-sans text-sm leading-relaxed text-dashboard-text-muted">
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
      <dl className="relative z-[1] m-0 min-w-0 self-end font-mono text-xs pointer-events-none md:self-center md:text-right">
        <div className="text-dashboard-text-muted">
          <dt className="sr-only">Updated</dt>
          <dd className="m-0">{formatRelativeTime(conversation.lastSeenAt)}</dd>
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-dashboard-text-subtle md:justify-end">
          {tokens ? <ConversationStat label="Tokens" value={tokens} /> : null}
          {cost ? <ConversationStat label="Cost" value={cost} /> : null}
          {runtime ? (
            <ConversationStat label="Runtime" value={runtime} />
          ) : null}
        </div>
      </dl>
      <div className="relative z-[1] flex justify-end self-end md:self-center">
        <button
          aria-label={`${conversation.archivedAt ? "Restore" : "Archive"} ${title}`}
          className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-md text-dashboard-text-muted transition hover:bg-dashboard-fill-hover hover:text-dashboard-text focus:outline-none focus:ring-2 focus:ring-dashboard-focus disabled:cursor-not-allowed disabled:opacity-50 md:size-9"
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

function ConversationStat(props: { label: string; value: string }) {
  return (
    <div className="text-dashboard-text-subtle">
      <dt className="sr-only">{props.label}</dt>
      <dd className="m-0">{props.value}</dd>
    </div>
  );
}
