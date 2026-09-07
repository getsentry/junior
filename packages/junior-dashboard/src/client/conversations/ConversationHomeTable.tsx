import { Archive, ArchiveRestore, LockKeyhole } from "lucide-react";
import { Link } from "react-router";

import {
  conversationActorLabel,
  conversationDisplayTitle,
  formatConversationActivityPreview,
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
import { conversationPath } from "./conversationRoutes";
import { useArchiveConversation } from "./queries";
import {
  buildConversationSections,
  type ConversationSection,
} from "./conversationSections";

/** Render the ordered conversation table on the dashboard home page. */
export function ConversationHomeTable(props: {
  conversations: Conversation[];
  emptyLabel?: string;
  timeZone: string;
}) {
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
  });
  return (
    <div
      className="min-w-[52rem] overflow-hidden rounded-lg border border-dashboard-border-subtle bg-dashboard-fill-faint"
      role="table"
    >
      <div
        className="grid grid-cols-[minmax(15rem,1.4fr)_minmax(22rem,1.8fr)_12rem_2.5rem] items-center gap-4 border-b border-dashboard-border-subtle bg-dashboard-overlay-soft px-4 py-2.5 font-mono text-xs uppercase tracking-[0.1em] text-dashboard-text-muted"
        role="row"
      >
        <div role="columnheader">Conversation</div>
        <div role="columnheader">Latest activity</div>
        <div className="text-right" role="columnheader">
          Stats
        </div>
        <span className="sr-only" role="columnheader">
          Actions
        </span>
      </div>
      {sections.map((section) => (
        <ConversationTableSection key={section.key} section={section} />
      ))}
    </div>
  );
}

function ConversationTableSection(props: { section: ConversationSection }) {
  return (
    <div role="rowgroup">
      <div className="border-b border-dashboard-border-subtle bg-black/10 px-4 py-2 font-mono text-2xs font-semibold uppercase tracking-[0.08em] text-dashboard-text-muted/60">
        {props.section.label}
      </div>
      {props.section.conversations.map((conversation) => (
        <ConversationTableRow
          conversation={conversation}
          key={conversation.id}
        />
      ))}
    </div>
  );
}

function ConversationTableRow(props: { conversation: Conversation }) {
  const conversation = props.conversation;
  const archive = useArchiveConversation(conversation.id);
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
  const stats = [tokens, cost, runtime].filter(Boolean).join(" · ");
  const isPrivate = conversation.visibility === "private";
  return (
    <div
      className="group relative grid grid-cols-[minmax(15rem,1.4fr)_minmax(22rem,1.8fr)_12rem_2.5rem] items-start gap-4 border-b border-dashboard-border-subtle px-4 py-3.5 last:border-b-0 hover:bg-dashboard-fill-soft"
      role="row"
    >
      <Link
        aria-label={`Open ${title}`}
        className="absolute inset-0 z-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-dashboard-focus"
        to={conversationPath(conversation.id)}
      />
      <div
        className="relative z-[1] flex min-w-0 items-start gap-2.5 pointer-events-none"
        role="cell"
      >
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
                status === "failed" ? "bg-rose-300" : "bg-white/25",
              )}
            />
          )}
        </span>
        <div className="min-w-0">
          <div className="truncate font-display text-base font-medium leading-snug text-dashboard-text">
            {title}
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-1.5 font-mono text-xs text-dashboard-text-muted">
            {location ? <span className="truncate">{location}</span> : null}
            {location && actor ? <span aria-hidden="true">·</span> : null}
            {actor ? <span className="truncate">{actor}</span> : null}
            <ConversationSidebarAnnotations
              annotations={conversation.sidebarAnnotations}
            />
          </div>
        </div>
      </div>
      <div className="relative z-[1] min-w-0 pointer-events-none" role="cell">
        {conversation.activityPreview ? (
          <p className="m-0 line-clamp-2 font-sans text-sm leading-relaxed text-dashboard-text-subtle">
            {formatConversationActivityPreview(
              conversation.activityPreview.text,
            )}
          </p>
        ) : (
          <p className="m-0 font-sans text-sm text-dashboard-text-muted">
            {status === "active" ? "Working…" : "No recent message"}
          </p>
        )}
      </div>
      <div
        className="relative z-[1] min-w-0 text-right pointer-events-none"
        role="cell"
      >
        {stats ? (
          <div className="truncate font-mono text-xs text-dashboard-text-subtle">
            {stats}
          </div>
        ) : null}
        <div className="mt-1 font-mono text-xs text-dashboard-text-muted">
          {formatRelativeTime(conversation.lastSeenAt)}
        </div>
      </div>
      <div className="relative z-[1] flex justify-end" role="cell">
        <button
          aria-label={`${conversation.archivedAt ? "Restore" : "Archive"} ${title}`}
          className="grid size-8 cursor-pointer place-items-center rounded-md text-dashboard-text-muted transition hover:bg-dashboard-fill-hover hover:text-dashboard-text focus:outline-none focus:ring-2 focus:ring-dashboard-focus disabled:cursor-not-allowed disabled:opacity-50"
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
    </div>
  );
}
