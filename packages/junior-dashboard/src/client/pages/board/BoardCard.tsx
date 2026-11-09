import type { BoardCard as BoardCardReport } from "@sentry/junior/api/schema";
import { MessagesSquare } from "lucide-react";
import { Link } from "react-router";

import { ObjectIcon } from "../../components/ObjectIcon";
import { OutboundLink } from "../../components/OutboundLink";
import { ParticipantAvatarStack } from "../../components/ParticipantAvatarStack";
import { StatusChip } from "../../components/StatusChip";
import { conversationPath } from "../../conversations/conversationRoutes";
import { formatRelativeTime } from "../../format";
import { cn } from "../../styles";

/** Name an age in one short unit, such as `12m` or `3d`, so the label fits. */
function shortAge(value: string): string {
  const minutes = Math.max(
    0,
    Math.round((Date.now() - Date.parse(value)) / 60_000),
  );
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * Show one object on the Board. The whole card opens its Conversation; the
 * object reference opens the object.
 */
export function BoardCard(props: { card: BoardCardReport }) {
  const { card } = props;
  const conversationTitle = card.conversation.rootTitle
    ? `${card.conversation.rootTitle} › ${card.conversation.title ?? "Thread"}`
    : (card.conversation.title ?? "Conversation");
  return (
    <article className="relative grid gap-2.5 rounded-lg border border-dashboard-border bg-dashboard-surface-raised p-3 transition-colors hover:border-dashboard-border-emphasis hover:bg-dashboard-surface-panel has-[:focus-visible]:border-dashboard-border-interactive">
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-dashboard-text-muted">
        <ObjectIcon
          objectType={card.objectType}
          size={14}
          status={card.status}
        />
        {card.url ? (
          <OutboundLink
            className="relative z-10 min-w-0 truncate font-mono text-inherit no-underline hover:text-dashboard-accent-text"
            href={card.url}
          >
            {card.label}
          </OutboundLink>
        ) : (
          <span className="min-w-0 truncate font-mono">{card.label}</span>
        )}
        <time
          className="ml-auto shrink-0 tabular-nums text-dashboard-text-faint"
          dateTime={card.updatedAt}
          title={formatRelativeTime(card.updatedAt)}
        >
          {shortAge(card.updatedAt)}
        </time>
      </div>
      <h3
        className={cn(
          "line-clamp-2 font-display text-sm font-normal text-pretty",
          card.column === "done"
            ? "text-dashboard-text-muted"
            : "text-dashboard-text",
        )}
      >
        {card.title}
      </h3>
      {card.working || card.needsViewer ? (
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {card.working ? (
            <StatusChip size="compact" tone="accent">
              Working
            </StatusChip>
          ) : null}
          {card.needsViewer ? (
            <StatusChip size="compact" tone="warning">
              Needs you
            </StatusChip>
          ) : null}
        </div>
      ) : null}
      <div className="flex min-w-0 items-center gap-2 border-t border-dashboard-border-subtle pt-2.5">
        <Link
          className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-dashboard-text-muted no-underline after:absolute after:inset-0 after:rounded-lg hover:text-dashboard-text focus-visible:outline-none"
          to={conversationPath(card.conversation.conversationId)}
        >
          <MessagesSquare aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate">{conversationTitle}</span>
        </Link>
        <span className="relative z-10 shrink-0">
          <ParticipantAvatarStack
            participants={card.participants}
            size="list"
          />
        </span>
      </div>
    </article>
  );
}
