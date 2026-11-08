import { useQuery } from "@tanstack/react-query";
import {
  Bot,
  ChevronRight,
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

import { DisplayText } from "../display-text/DisplayText";
import { formatTime } from "../format";
import { fetchDashboardJson } from "../http";
import { conversationSideReadQueryKey } from "./queries";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible";
import { dashboardDisclosureChevronClass } from "../styles";
import { DetailsList, DetailsRow } from "./DetailsList";

/** Load the active Watches that one Conversation owns. */
export function useConversationWatches(conversationId: string) {
  return useQuery({
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        conversationWatchesReportSchema,
        `/api/conversations/${encodeURIComponent(conversationId)}/watches`,
        signal,
      ),
    queryKey: conversationSideReadQueryKey(conversationId, "watches"),
    retry: false,
  });
}

/**
 * Show what can wake this Conversation: one line per active Watch. A line
 * expands to show the reason and the event types that deliver to it.
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
 * Show one Watch as a single line with its resource. When the resource has a
 * web page, the line opens it and a chevron shows the details. Otherwise the
 * line itself shows the details.
 */
function WatchRow(props: { watch: ConversationWatch }) {
  const { watch } = props;
  const Icon = watch.redacted
    ? LockKeyhole
    : (resourceIcons[watch.resourceType] ?? Eye);
  const resource = `${watch.namespace} ${watch.resourceType.replaceAll("_", " ")}`;
  const icon = <Icon aria-hidden="true" className="size-3.5" />;
  const title = watch.label ?? `Private ${resource}`;

  return (
    <Collapsible className="min-w-0">
      {watch.url ? (
        // The row opens the watched resource, like a linked work row. The
        // chevron beside it shows the details.
        <WatchDetailsRow label={title}>
          <DetailsRow href={watch.url} icon={icon} title={title} />
        </WatchDetailsRow>
      ) : (
        <DetailsRow
          disclosure
          icon={icon}
          meta={<WatchChevron />}
          title={title}
        />
      )}
      <WatchDetails watches={[watch]} />
    </Collapsible>
  );
}

/**
 * Place a link row beside a chevron that shows the Watch details under it.
 * Use it inside a `Collapsible` that also holds `WatchDetails`.
 */
export function WatchDetailsRow(props: { children: ReactNode; label: string }) {
  return (
    <div className="flex min-w-0 items-start gap-0.5">
      <div className="min-w-0 flex-1">{props.children}</div>
      <CollapsibleTrigger
        aria-label={`Details for ${props.label}`}
        className="group grid size-8 shrink-0 place-items-center rounded-md text-dashboard-text-muted transition-colors hover:bg-dashboard-surface-hover hover:text-dashboard-text focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus"
      >
        <WatchChevron />
      </CollapsibleTrigger>
    </div>
  );
}

function WatchChevron() {
  return (
    <span className="grid size-5 place-items-center">
      <ChevronRight
        aria-hidden="true"
        className={dashboardDisclosureChevronClass}
      />
    </span>
  );
}

/**
 * Show why each Watch exists and which events wake the Conversation. The
 * expiry is an internal limit, so it does not show.
 */
export function WatchDetails(props: { watches: ConversationWatch[] }) {
  return (
    // Indent under the title: icon column, column gap, and row padding.
    <CollapsibleContent className="grid min-w-0 gap-3 pb-2 pl-9 pr-1.5 pt-0.5 text-xs leading-4 text-dashboard-text-muted">
      {props.watches.map((watch) => (
        <WatchDetail key={watch.id} watch={watch} />
      ))}
    </CollapsibleContent>
  );
}

function WatchDetail(props: { watch: ConversationWatch }) {
  const { watch } = props;
  // A timer has one event, and its fire time already says when it wakes.
  const events = watch.firesAt ? [] : watch.events;
  const filters = Object.entries(watch.match ?? {});
  return (
    <div className="grid min-w-0 gap-1.5">
      {watch.intent ? (
        <p className="m-0 break-words">
          <DisplayText inline text={watch.intent} />
        </p>
      ) : null}
      {watch.firesAt ? (
        <p className="m-0">
          Fires{" "}
          <time dateTime={watch.firesAt}>
            {formatTime(watch.firesAt, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </time>
        </p>
      ) : null}
      {events.length > 0 || filters.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1">
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
        </div>
      ) : null}
      {watch.childAgent ? (
        <p className="m-0 flex min-w-0 items-center gap-1">
          <Bot aria-hidden="true" className="size-3 shrink-0" />
          <span className="truncate">
            via {watch.childAgent.name ?? "child conversation"}
          </span>
        </p>
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
