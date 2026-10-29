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
import type { ReactNode } from "react";
import {
  conversationWatchesReportSchema,
  type ConversationWatch,
} from "@sentry/junior/api/schema";

import { formatTime } from "../format";
import { fetchDashboardJson } from "../http";
import { DetailsList, DetailsRow, DetailsRowLine } from "./DetailsList";

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
 * the reason, and the event types that deliver to it.
 */
export function ConversationWatches(props: { watches: ConversationWatch[] }) {
  return (
    <DetailsList
      itemKey={(watch) => watch.id}
      items={props.watches}
      renderItem={(watch) => <WatchRow watch={watch} />}
    />
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
 * Show one Watch in up to three short lines: the resource and time left, the
 * reason it exists, then the event types that wake the Conversation.
 */
function WatchRow(props: { watch: ConversationWatch }) {
  const { watch } = props;
  const Icon = watch.redacted
    ? LockKeyhole
    : (resourceIcons[watch.resourceType] ?? Eye);
  const isTimer = watch.firesAt !== undefined;
  const until = watch.firesAt ?? watch.expiresAt;
  const resource = `${watch.namespace} ${watch.resourceType.replaceAll("_", " ")}`;
  // A timer has one event, and the time already says when it fires.
  const events = isTimer ? [] : watch.events;
  const filters = Object.entries(watch.match ?? {});

  return (
    <DetailsRow
      icon={<Icon aria-hidden="true" className="size-3.5" />}
      meta={
        <time dateTime={until}>
          {isTimer
            ? `in ${formatRemaining(until)}`
            : `${formatRemaining(until)} left`}
        </time>
      }
      title={watch.label ?? `Private ${resource}`}
      tooltip={`${isTimer ? "Fires" : "Expires"} ${formatTime(until, {
        dateStyle: "medium",
        timeStyle: "short",
      })}`}
    >
      {watch.intent ? (
        <DetailsRowLine className="line-clamp-2 break-words">
          {watch.intent}
        </DetailsRowLine>
      ) : null}
      {events.length > 0 || filters.length > 0 || watch.childAgent ? (
        <DetailsRowLine className="flex flex-wrap items-center gap-1 pt-0.5">
          {events.map((event) => (
            <WatchChip key={event}>
              {watchEventLabel(event, watch.resourceType)}
            </WatchChip>
          ))}
          {filters.map(([key, value]) => (
            <WatchChip filter key={`match:${key}`}>
              {key.replaceAll("_", " ")}: {[value].flat().join(", ")}
            </WatchChip>
          ))}
          {watch.childAgent ? (
            <span className="inline-flex min-w-0 items-center gap-1 px-0.5">
              <Bot aria-hidden="true" className="size-3 shrink-0" />
              <span className="truncate">
                via {watch.childAgent.name ?? "subagent"}
              </span>
            </span>
          ) : null}
        </DetailsRowLine>
      ) : null}
    </DetailsRow>
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
