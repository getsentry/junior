import {
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  Eye,
  type LucideIcon,
} from "lucide-react";
import { type ReactNode, useContext, useState } from "react";
import {
  isAgentUpdateEventType,
  isLegacyResultEventType,
  type ConversationChildAgent,
  type ConversationDetailReport,
  type ConversationWatch,
} from "@sentry/junior/api/schema";

import { statusToneClass } from "../components/StatusChip";
import { DropdownMenuItem } from "../components/ui/dropdown-menu";
import { Spinner } from "../components/ui/spinner";
import { cn } from "../styles";
import { ArchiveChildDialog } from "./ArchiveChildDialog";
import { useArchiveConversation } from "./conversationArchive";
import {
  childAgentStatusLabel,
  useConversationChildAgents,
} from "./ConversationChildAgents";
import type { ConversationDrawerTarget } from "./ConversationDrawer";
import { conversationPath } from "./conversationRoutes";
import {
  useConversationWatches,
  WatchCancelItems,
} from "./ConversationWatches";
import {
  DetailsRow,
  DetailsRowLine,
  DetailsRowMenu,
  DetailsSection,
} from "./DetailsList";
import { FeedThreads } from "./feedThreads";

/** Where a child Conversation stands, from its own run only. */
export type ChildState =
  | "blocked"
  | "failed"
  | "running"
  | "watching"
  | "paused"
  | "done";

/**
 * Read where a child Conversation stands. A wait on the viewer comes first,
 * then a run that is going, then how an earlier Turn ended. An archived
 * child is done.
 */
export function childState(child: ConversationChildAgent): ChildState {
  if (child.archivedAt) return "done";
  const { lastResult, status, treeState } = child;
  if (treeState === "needs_you") return "blocked";
  if (status === "running" || status === "pending") return "running";
  if (status === "failed") return "failed";
  if (status === "idle" && lastResult === "failed") return "failed";
  if (status === "idle" && lastResult === "blocked") return "blocked";
  // A nested child can still work after this child's own run ended.
  if (treeState === "working") return "running";
  if (status === "paused") return "paused";
  return child.watching ? "watching" : "done";
}

/**
 * Read why each child stopped from the parent's loaded Events: the latest
 * agent update that a child sent, by child Conversation id.
 */
export function childUpdateReasons(
  events: ConversationDetailReport["events"] | undefined,
): Map<string, string> {
  const reasons = new Map<string, string>();
  for (const { data } of events ?? []) {
    if (
      data.type === "message" &&
      data.role === "user" &&
      data.eventType !== undefined &&
      (isLegacyResultEventType(data.eventType) ||
        (isAgentUpdateEventType(data.eventType) &&
          data.eventWatchId === undefined)) &&
      data.eventIdentifier &&
      data.text
    ) {
      reasons.set(data.eventIdentifier, data.text);
    }
  }
  return reasons;
}

/** Name a child Conversation: a Thread's own title first, then its task. */
export function childTitle(
  child: ConversationChildAgent,
  feedTitle: string | undefined,
): string {
  const kind = child.kind === "thread" ? "Thread" : "Task";
  if (child.redacted) return `Private ${kind.toLowerCase()}`;
  return feedTitle || child.title || child.name || kind;
}

const stateLabels: Record<ChildState, string> = {
  blocked: "Blocked",
  done: "Done",
  failed: "Failed",
  paused: "Paused",
  running: "Running",
  watching: "Watching",
};

const stateIcons: Record<Exclude<ChildState, "running">, LucideIcon> = {
  blocked: CircleAlert,
  done: CircleCheck,
  failed: CircleX,
  paused: Clock,
  watching: Eye,
};

/**
 * Mark where a child stands with the sidebar's spinner, or with the colors
 * of the transcript's child chip for blocked and failed.
 */
function ChildStateIcon(props: { state: ChildState }) {
  const label = stateLabels[props.state];
  if (props.state === "running") {
    return (
      <Spinner aria-label={label} className="size-4 text-dashboard-accent" />
    );
  }
  const Icon = stateIcons[props.state];
  return (
    <Icon
      aria-label={label}
      className={cn(
        "size-4",
        props.state === "blocked"
          ? statusToneClass.warning
          : props.state === "failed"
            ? statusToneClass.danger
            : "text-dashboard-text-muted",
      )}
      role="img"
    />
  );
}

/**
 * List the child Conversations of one Conversation, Threads and Tasks, by
 * their own state. A blocked or failed child names why. Finished and
 * archived children hide behind "Show finished".
 */
export function ConversationAgents(props: {
  canEdit: boolean;
  conversationId: string;
  /** The parent's loaded Events, which hold each child's last update. */
  events: ConversationDetailReport["events"] | undefined;
  onOpenTask(target: ConversationDrawerTarget): void;
}) {
  const children =
    useConversationChildAgents(props.conversationId).data?.agents ?? [];
  const watches =
    useConversationWatches(props.conversationId).data?.watches ?? [];
  const reasons = childUpdateReasons(props.events);
  const rows = children.map((child) => {
    const state = childState(child);
    const row = (
      <ChildRow
        canEdit={props.canEdit}
        child={child}
        conversationId={props.conversationId}
        key={child.conversationId}
        onOpenTask={props.onOpenTask}
        reason={
          state === "blocked" || state === "failed"
            ? reasons.get(child.conversationId)
            : undefined
        }
        state={state}
        watches={watches.filter(
          (watch) => watch.childAgent?.conversationId === child.conversationId,
        )}
      />
    );
    return { row, state };
  });
  // The children to look at lead, then running ones, then waiting ones.
  // `sort` is stable, so each state keeps the loaded order.
  const rank = (state: ChildState) =>
    state === "blocked" || state === "failed" ? 0 : state === "running" ? 1 : 2;
  const open = rows
    .filter((item) => item.state !== "done")
    .sort((left, right) => rank(left.state) - rank(right.state));
  return (
    <DetailsSection
      finished={rows
        .filter((item) => item.state === "done")
        .map((item) => item.row)}
      rows={open.map((item) => item.row)}
      title="Agents"
    />
  );
}

function ChildRow(props: {
  canEdit: boolean;
  child: ConversationChildAgent;
  conversationId: string;
  onOpenTask(target: ConversationDrawerTarget): void;
  reason: string | undefined;
  state: ChildState;
  watches: ConversationWatch[];
}) {
  const { child } = props;
  const feedThread = useContext(FeedThreads).get(child.conversationId);
  const title = childTitle(child, feedThread?.displayTitle);
  // Archive checks the child's last activity, which only a feed Thread has.
  const lastSeenAt = feedThread?.lastSeenAt;
  const menu =
    props.canEdit && !child.redacted && (lastSeenAt || props.watches.length) ? (
      <ChildMenu child={child} lastSeenAt={lastSeenAt} title={title}>
        <WatchCancelItems
          conversationId={props.conversationId}
          watches={props.watches}
        />
      </ChildMenu>
    ) : null;
  return (
    <DetailsRow
      icon={<ChildStateIcon state={props.state} />}
      menu={menu}
      title={title}
      {...childOpener(child, props.onOpenTask)}
    >
      {props.reason ? <DetailsRowLine>{props.reason}</DetailsRowLine> : null}
    </DetailsRow>
  );
}

/** A Thread opens its page. A Task opens its transcript beside this page. */
function childOpener(
  child: ConversationChildAgent,
  onOpenTask: (target: ConversationDrawerTarget) => void,
): { onClick(): void } | { to: string } {
  if (child.kind === "thread") {
    return { to: conversationPath(child.conversationId) };
  }
  return {
    onClick: () =>
      onOpenTask({
        conversationId: child.conversationId,
        ...(child.redacted
          ? undefined
          : {
              ...(child.name ? { agentName: child.name } : undefined),
              label: child.title ?? child.name,
            }),
        status: childAgentStatusLabel(child),
      }),
  };
}

/**
 * Archive a child after a confirm, or restore it at once, plus Cancel for
 * the child's Watches. A Task has no feed row with its last activity, so it
 * is archived from its own page.
 */
function ChildMenu(props: {
  children: ReactNode;
  child: ConversationChildAgent;
  lastSeenAt: string | undefined;
  title: string;
}) {
  const { child, lastSeenAt } = props;
  const archive = useArchiveConversation(child.conversationId);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const archived = Boolean(child.archivedAt);
  const setArchived = (value: boolean) => {
    if (lastSeenAt) archive.mutate({ archived: value, lastSeenAt });
  };
  return (
    <>
      <DetailsRowMenu
        disabled={archive.isPending}
        label={`Change ${props.title}`}
      >
        {props.children}
        {lastSeenAt ? (
          <DropdownMenuItem
            onClick={() =>
              archived ? setArchived(false) : setConfirmArchive(true)
            }
          >
            {archived ? "Restore" : "Archive"}
          </DropdownMenuItem>
        ) : null}
      </DetailsRowMenu>
      {confirmArchive ? (
        <ArchiveChildDialog
          hasChildren={Boolean(child.childAgentTotals?.count)}
          onClose={() => setConfirmArchive(false)}
          onConfirm={() => {
            setConfirmArchive(false);
            setArchived(true);
          }}
        />
      ) : null}
    </>
  );
}
