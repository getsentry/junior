import { useQuery } from "@tanstack/react-query";
import {
  Bot,
  CircleDot,
  Eye,
  FolderGit2,
  GitPullRequest,
  Hash,
  LockKeyhole,
  type LucideIcon,
  Package,
  Rocket,
  Tag,
  Timer,
  Users,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  conversationWatchesReportSchema,
  type ConversationWatch,
} from "@sentry/junior/api/schema";

import { formatTime } from "../format";
import { fetchDashboardJson } from "../http";

/** Rows shown before the list asks to show the rest. */
const COLLAPSED_WATCH_COUNT = 3;

/** Load the active Watches that one Conversation owns. */
export function useConversationWatches(conversationId: string) {
  return useQuery({
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        conversationWatchesReportSchema,
        `/api/conversations/${encodeURIComponent(conversationId)}/watches`,
        signal,
      ),
    queryKey: ["conversation", conversationId, "watches"],
    retry: false,
  });
}

/**
 * Show what can wake this Conversation: each active Watch with the resource,
 * the reason, and the event types that deliver to it. Long lists show the
 * first rows and let the reader show the rest.
 */
export function ConversationWatches(props: { watches: ConversationWatch[] }) {
  const [expanded, setExpanded] = useState(false);
  const hidden = props.watches.length - COLLAPSED_WATCH_COUNT;
  const visible =
    expanded || hidden <= 0
      ? props.watches
      : props.watches.slice(0, COLLAPSED_WATCH_COUNT);

  return (
    <div className="grid min-w-0 gap-2">
      <ul aria-label="Active watches" className="m-0 grid list-none p-0">
        {visible.map((watch) => (
          <li
            className="border-t border-dashboard-border-subtle py-2.5 first:border-t-0 first:pt-0 last:pb-0"
            key={watch.id}
          >
            <WatchRow watch={watch} />
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <button
          aria-expanded={expanded}
          className="ml-5.5 justify-self-start rounded-md px-1 py-0.5 text-xs font-medium text-dashboard-text-muted transition-colors hover:text-dashboard-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus"
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          {expanded ? "Show fewer" : `Show ${hidden} more`}
        </button>
      ) : null}
    </div>
  );
}

const resourceIcons: Partial<Record<string, LucideIcon>> = {
  channel: Hash,
  deployment: Rocket,
  deployment_source: Rocket,
  issue: CircleDot,
  pull_request: GitPullRequest,
  release_source: Tag,
  repository: FolderGit2,
  team: Users,
  timer: Timer,
  workspace_snapshot: Package,
};

/**
 * Show one Watch in three short lines: the resource and time left, the reason
 * it exists, then the event types that wake the Conversation.
 */
function WatchRow(props: { watch: ConversationWatch }) {
  const { watch } = props;
  const Icon = watch.redacted
    ? LockKeyhole
    : (resourceIcons[watch.resourceType] ?? Eye);
  const isTimer = watch.firesAt !== undefined;
  const until = watch.firesAt ?? watch.expiresAt;
  const resource = `${watch.namespace} ${watch.resourceType.replaceAll("_", " ")}`;

  return (
    <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2.5 gap-y-1">
      <span className="mt-0.5 grid size-4 shrink-0 place-items-center text-dashboard-text-muted">
        <Icon aria-hidden="true" className="size-3.5" />
      </span>
      <span className="min-w-0 truncate text-sm font-medium leading-5 text-dashboard-text">
        {watch.label ?? `Private ${resource}`}
      </span>
      <time
        className="shrink-0 text-xs leading-5 tabular-nums text-dashboard-text-muted"
        dateTime={until}
        title={`${isTimer ? "Fires" : "Expires"} ${formatTime(until, {
          dateStyle: "medium",
          timeStyle: "short",
        })}`}
      >
        {isTimer
          ? `in ${formatRemaining(until)}`
          : `${formatRemaining(until)} left`}
      </time>
      {watch.intent ? (
        <p className="col-start-2 col-end-4 m-0 line-clamp-2 min-w-0 break-words text-xs leading-4 text-dashboard-text-muted">
          {watch.intent}
        </p>
      ) : null}
      {/* A timer has one event, and the time already says when it fires. */}
      {!isTimer || watch.match || watch.childAgent ? (
        <div className="col-start-2 col-end-4 flex min-w-0 flex-wrap items-center gap-1">
          {isTimer
            ? null
            : watch.events.map((event) => (
                <WatchChip key={event}>
                  {watchEventLabel(event, watch.resourceType)}
                </WatchChip>
              ))}
          {Object.entries(watch.match ?? {}).map(([key, value]) => (
            <WatchChip filter key={`match:${key}`}>
              {key.replaceAll("_", " ")}: {[value].flat().join(", ")}
            </WatchChip>
          ))}
          {watch.childAgent ? (
            <span className="inline-flex min-w-0 items-center gap-1 px-0.5 text-xs leading-4 text-dashboard-text-muted">
              <Bot aria-hidden="true" className="size-3 shrink-0" />
              <span className="truncate">
                via {watch.childAgent.name ?? "subagent"}
              </span>
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Label one event type, or a dashed match filter that narrows the events. */
function WatchChip(props: { children: ReactNode; filter?: boolean }) {
  return (
    <span
      className={
        props.filter
          ? "min-w-0 truncate rounded-md border border-dashed border-dashboard-border px-1.5 py-px text-xs leading-4 text-dashboard-text-muted"
          : "min-w-0 truncate rounded-md bg-dashboard-fill-soft px-1.5 py-px text-xs leading-4 text-dashboard-text-subtle"
      }
    >
      {props.children}
    </span>
  );
}

/**
 * Turn an event type into a short trigger label. The row already names the
 * resource, so `pull_request.checks.failed` reads as "checks failed".
 */
function watchEventLabel(event: string, resourceType: string): string {
  const parts = event.split(".");
  const rest =
    parts[0] === resourceType && parts.length > 1 ? parts.slice(1) : parts;
  return rest.join(" ").replaceAll("_", " ");
}

/** Format the time until a Watch fires or expires as one compact unit. */
function formatRemaining(value: string): string {
  const ms = Math.max(0, Date.parse(value) - Date.now());
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
