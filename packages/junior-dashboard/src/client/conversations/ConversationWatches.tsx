import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "../components/ui/badge";
import {
  conversationWatchesReportSchema,
  type ConversationWatch,
  type ConversationWatchesReport,
} from "@sentry/junior/api/schema";

import { DisplayText } from "../display-text/DisplayText";
import { deleteDashboardResource } from "../http";
import {
  revalidatedJsonQuery,
  withoutVersion,
  type ContentVersioned,
} from "../revalidation";
import { conversationSideReadQueryKey } from "./conversationSideReads";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible";
import { dashboardDisclosureChevronClass } from "../styles";
import { DetailsList, DetailsRow, DetailsRowLine } from "./DetailsList";
import { formatRelativeTime, formatTime } from "../time";

/** Load the active Watches that one Conversation owns. */
export function useConversationWatches(conversationId: string) {
  return useQuery({
    queryFn: revalidatedJsonQuery(
      conversationWatchesReportSchema,
      `/api/conversations/${encodeURIComponent(conversationId)}/watches`,
    ),
    queryKey: conversationSideReadQueryKey(conversationId, "watches"),
    retry: false,
  });
}

/**
 * Cancel one Watch. Only the Conversation that created a Watch cancels it,
 * so a child agent's Watch goes through the child. The Watch leaves this
 * Conversation's list at once; a failed cancel brings it back.
 */
export function useCancelConversationWatch(conversationId: string) {
  const queryClient = useQueryClient();
  const queryKey = conversationSideReadQueryKey(conversationId, "watches");
  return useMutation({
    mutationFn: (watch: ConversationWatch) =>
      deleteDashboardResource(
        `/api/conversations/${encodeURIComponent(watch.childAgent?.conversationId ?? conversationId)}/watches/${encodeURIComponent(watch.id)}`,
      ),
    onMutate: async (watch) => {
      await queryClient.cancelQueries({ queryKey });
      queryClient.setQueryData<ContentVersioned<ConversationWatchesReport>>(
        queryKey,
        (report) =>
          report &&
          withoutVersion(
            {
              ...report,
              watches: report.watches.filter(
                (candidate) => candidate.id !== watch.id,
              ),
            },
            "contentVersion",
          ),
      );
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
}

/** Cancel one Watch. Absent when the viewer cannot act on the Conversation. */
export type CancelWatch = (watch: ConversationWatch) => void;

/**
 * Show what can wake this Conversation: one row per active Watch with its
 * intent, when it fires or expires, and Cancel. A line expands to show the
 * event types that deliver to it.
 */
export function ConversationWatches(props: {
  onCancel?: CancelWatch | undefined;
  watches: ConversationWatch[];
}) {
  return (
    <DetailsList
      itemKey={(watch) => watch.id}
      items={props.watches}
      renderItem={(watch) => (
        <WatchRow onCancel={props.onCancel} watch={watch} />
      )}
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
 * Show one Watch as a row: what Junior will do, then when it fires or
 * expires. The label names the resource on hover. When the resource has a
 * web page, the line opens it and a chevron shows the details. Otherwise the
 * line itself shows the details.
 */
function WatchRow(props: {
  onCancel?: CancelWatch | undefined;
  watch: ConversationWatch;
}) {
  const { watch } = props;
  const Icon = watch.redacted
    ? LockKeyhole
    : (resourceIcons[watch.resourceType] ?? Eye);
  const resource = `${watch.namespace} ${watch.resourceType.replaceAll("_", " ")}`;
  const icon = <Icon aria-hidden="true" className="size-3.5" />;
  const title = watch.intent ?? watch.label ?? `Private ${resource}`;
  // The time takes its own line, so a long intent keeps the row width.
  const time = (
    <DetailsRowLine>
      <WatchTime watch={watch} />
    </DetailsRowLine>
  );
  const cancel = props.onCancel ? (
    <WatchCancelButton onCancel={props.onCancel} title={title} watch={watch} />
  ) : null;

  return (
    <Collapsible className="min-w-0">
      {watch.url ? (
        // The row opens the watched resource, like a linked work row. The
        // chevron beside it shows the details.
        <WatchDetailsRow action={cancel} label={title}>
          <DetailsRow
            href={watch.url}
            icon={icon}
            title={title}
            tooltip={watch.label}
          >
            {time}
          </DetailsRow>
        </WatchDetailsRow>
      ) : (
        <div className="flex min-w-0 items-start gap-0.5">
          <div className="min-w-0 flex-1">
            <DetailsRow
              disclosure
              icon={icon}
              meta={<WatchChevron />}
              title={title}
              tooltip={watch.label}
            >
              {time}
            </DetailsRow>
          </div>
          {cancel}
        </div>
      )}
      <WatchDetails watches={[watch]} />
    </Collapsible>
  );
}

/**
 * Place a link row beside a chevron that shows the Watch details under it,
 * and an optional `action` after the chevron. Use it inside a `Collapsible`
 * that also holds `WatchDetails`.
 */
export function WatchDetailsRow(props: {
  action?: ReactNode;
  children: ReactNode;
  label: string;
}) {
  return (
    <div className="flex min-w-0 items-start gap-0.5">
      <div className="min-w-0 flex-1">{props.children}</div>
      <CollapsibleTrigger
        aria-label={`Details for ${props.label}`}
        className="group grid size-8 shrink-0 place-items-center rounded-md text-dashboard-text-muted transition-colors hover:bg-dashboard-surface-hover hover:text-dashboard-text focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus"
      >
        <WatchChevron />
      </CollapsibleTrigger>
      {props.action}
    </div>
  );
}

/**
 * Say when a Watch fires (a timer) or expires (an event Watch), relative to
 * now. The exact time shows on hover.
 */
function WatchTime(props: { watch: ConversationWatch }) {
  const { watch } = props;
  const at = watch.firesAt ?? watch.expiresAt;
  const verb = watch.firesAt ? "Fires" : "Expires";
  return (
    <time
      dateTime={at}
      title={`${verb} ${formatTime(at, { dateStyle: "medium", timeStyle: "short" })}`}
    >
      {verb.toLowerCase()} {formatRelativeTime(at)}
    </time>
  );
}

function WatchCancelButton(props: {
  onCancel: CancelWatch;
  title: string;
  watch: ConversationWatch;
}) {
  return (
    <button
      aria-label={`Cancel ${props.title}`}
      className="grid size-8 shrink-0 place-items-center rounded-md text-dashboard-text-muted transition-colors hover:bg-dashboard-surface-hover hover:text-dashboard-text focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus"
      onClick={() => props.onCancel(props.watch)}
      title="Cancel"
      type="button"
    >
      <X aria-hidden="true" size={14} />
    </button>
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
 * Show why each Watch exists and which events wake the Conversation. Under a
 * linked work row, `showTime` also shows when each Watch fires or expires,
 * with Cancel when `onCancel` is set. A Watch row shows those itself.
 */
export function WatchDetails(props: {
  onCancel?: CancelWatch | undefined;
  showTime?: boolean;
  watches: ConversationWatch[];
}) {
  return (
    // Indent under the title: icon column, column gap, and row padding.
    <CollapsibleContent className="grid min-w-0 gap-3 pb-2 pl-9 pr-1.5 pt-0.5 text-xs leading-4 text-dashboard-text-muted">
      {props.watches.map((watch) => (
        <WatchDetail
          key={watch.id}
          onCancel={props.onCancel}
          showTime={props.showTime === true}
          watch={watch}
        />
      ))}
    </CollapsibleContent>
  );
}

function WatchDetail(props: {
  onCancel?: CancelWatch | undefined;
  showTime: boolean;
  watch: ConversationWatch;
}) {
  const { onCancel, watch } = props;
  // A timer has one event, and its fire time already says when it wakes.
  const events = watch.firesAt ? [] : watch.events;
  const filters = Object.entries(watch.match ?? {});
  const intent = watch.intent ? (
    <DisplayText inline text={watch.intent} />
  ) : null;
  return (
    <div className="grid min-w-0 gap-1.5">
      {props.showTime ? (
        <div className="flex min-w-0 items-start gap-2">
          <p className="m-0 min-w-0 flex-1 break-words">{intent}</p>
          <span className="shrink-0 tabular-nums">
            <WatchTime watch={watch} />
          </span>
          {onCancel ? (
            // Pull the button into the row padding, so its icon lines up
            // with the text.
            <span className="-my-2 -mr-1.5">
              <WatchCancelButton
                onCancel={onCancel}
                title={watch.intent ?? watch.label ?? "Watch"}
                watch={watch}
              />
            </span>
          ) : null}
        </div>
      ) : intent ? (
        <p className="m-0 break-words">{intent}</p>
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
    <Badge
      className="min-w-0 truncate py-px"
      variant={props.filter ? "dashed" : "secondary"}
    >
      {props.children}
    </Badge>
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
