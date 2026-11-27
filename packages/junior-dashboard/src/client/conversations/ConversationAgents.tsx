import { type ReactNode, useContext, useState } from "react";
import {
  isAgentUpdateEventType,
  isLegacyResultEventType,
  type ConversationChildAgent,
  type ConversationDetailReport,
  type ConversationWatch,
} from "@sentry/junior/api/schema";

import { DropdownMenuItem } from "../components/ui/dropdown-menu";
import { DisplayText } from "../display-text/DisplayText";
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
import { StatusIndicator, statusIndicatorState } from "./StatusIndicator";

/** Where a child Conversation stands, from its own run only. */
export type ChildState =
  | "needs_you"
  | "blocked"
  | "failed"
  | "running"
  | "watching"
  | "paused"
  | "stopped"
  | "done";

/**
 * Read where a child Conversation stands. A wait on the viewer comes first,
 * then a run that is going, then how an earlier Turn ended. An archived
 * child is done.
 */
export function childState(child: ConversationChildAgent): ChildState {
  if (child.archivedAt) return "done";
  const { lastResult, status, treeState } = child;
  if (treeState === "needs_you") return "needs_you";
  if (status === "running" || status === "pending") return "running";
  if (status === "failed") return "failed";
  if (status === "idle" && lastResult === "failed") return "failed";
  if (status === "idle" && lastResult === "blocked") return "blocked";
  // A nested child can still work after this child's own run ended.
  if (treeState === "working") return "running";
  if (status === "paused") return "paused";
  if (child.watching) return "watching";
  return status === "stopped" ? "stopped" : "done";
}

/** Finished children hide behind "Show finished". */
const FINISHED_STATES: ReadonlySet<ChildState> = new Set(["done", "stopped"]);

/**
 * Read why each child is blocked or failed from the parent's loaded Events:
 * the latest blocked or failed agent update that a child sent, by child
 * Conversation id.
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
      (data.eventStatus === "blocked" || data.eventStatus === "failed") &&
      data.eventIdentifier &&
      data.text
    ) {
      reasons.set(data.eventIdentifier, data.text);
    }
  }
  return reasons;
}

/** Name a child Conversation: a Thread's own title first, then its task. */
function childTitle(
  child: ConversationChildAgent,
  feedTitle: string | undefined,
): string {
  const kind = child.kind === "thread" ? "Thread" : "Task";
  if (child.redacted) return `Private ${kind.toLowerCase()}`;
  return feedTitle || child.title || child.name || kind;
}

/** Read a child's status indicator from its own run and its tree. */
function childIndicatorState(child: ConversationChildAgent) {
  const state = childState(child);
  return statusIndicatorState({
    archivedAt: child.archivedAt,
    latestTurnFailed: state === "failed",
    treeState: child.treeState,
    turnActive: state === "running",
  });
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
    state === "needs_you" || state === "blocked" || state === "failed"
      ? 0
      : state === "running"
        ? 1
        : 2;
  const open = rows
    .filter((item) => !FINISHED_STATES.has(item.state))
    .sort((left, right) => rank(left.state) - rank(right.state));
  return (
    <DetailsSection
      finished={rows
        .filter((item) => FINISHED_STATES.has(item.state))
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
      icon={
        <StatusIndicator
          className="size-4"
          state={childIndicatorState(child)}
        />
      }
      menu={menu}
      title={title}
      {...childOpener(child, props.onOpenTask)}
    >
      {props.reason ? (
        <DetailsRowLine>
          <DisplayText inline text={props.reason} />
        </DetailsRowLine>
      ) : null}
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
 * Archive a child after a confirm, plus Cancel for the child's Watches. A
 * Task, or an archived Thread, has no feed row with its last activity, so
 * it is archived or restored from its own page.
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
  return (
    <>
      <DetailsRowMenu
        disabled={archive.isPending}
        label={`Change ${props.title}`}
      >
        {props.children}
        {lastSeenAt ? (
          <DropdownMenuItem onClick={() => setConfirmArchive(true)}>
            Archive
          </DropdownMenuItem>
        ) : null}
      </DetailsRowMenu>
      {confirmArchive ? (
        <ArchiveChildDialog
          hasChildren={Boolean(child.childAgentTotals?.count)}
          onClose={() => setConfirmArchive(false)}
          onConfirm={() => {
            setConfirmArchive(false);
            if (lastSeenAt) archive.mutate({ archived: true, lastSeenAt });
          }}
        />
      ) : null}
    </>
  );
}
