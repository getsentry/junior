import { useQuery } from "@tanstack/react-query";
import {
  Archive,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CirclePause,
  CircleX,
  LockKeyhole,
  type LucideIcon,
} from "lucide-react";
import { useContext, useState } from "react";
import {
  conversationChildAgentsReportSchema,
  type ConversationChildAgent,
} from "@sentry/junior/api/schema";

import type { StatusChipTone } from "../components/StatusChip";
import { Button } from "../components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible";
import { Spinner } from "../components/ui/spinner";
import { formatConversationCostTotal, formatUsageTotal } from "../format";
import { revalidatedJsonQuery } from "../revalidation";
import { conversationSideReadQueryKey } from "./conversationSideReads";
import { conversationPath } from "./conversationRoutes";
import { ConversationStateIcon } from "./ConversationStateIcon";
import { FeedThreads } from "./feedThreads";
import { cn, dashboardDisclosureChevronClass } from "../styles";
import {
  attentionGroups,
  type Attention,
  type AttentionGroup,
} from "./conversationSections";
import {
  DetailsCard,
  DetailsList,
  DetailsRow,
  DetailsRowLine,
} from "./DetailsList";
import type { ConversationDrawerTarget } from "./ConversationDrawer";
import { formatRuntime, formatTime } from "../time";

const statusTones: Partial<Record<string, StatusChipTone>> = {
  active: "info",
  blocked: "warning",
  completed: "success",
  error: "danger",
  failed: "danger",
  needs_input: "warning",
  paused: "info",
  running: "info",
};

/** Pick the status tone for a child agent, its transcript row, or its detail. */
export function subagentStatusTone(status: string): StatusChipTone {
  return statusTones[status] ?? "neutral";
}

/**
 * Name what a child agent does now. Once it is idle, its last result says
 * more, such as `blocked`.
 */
export function childAgentStatusLabel(
  agent: Pick<ConversationChildAgent, "lastResult" | "status">,
): string {
  return agent.status === "idle"
    ? (agent.lastResult ?? agent.status)
    : agent.status;
}

/** Load the child agents of one Conversation with runtime status. */
export function useConversationChildAgents(
  conversationId: string,
  enabled = true,
) {
  return useQuery({
    enabled,
    queryFn: revalidatedJsonQuery(
      conversationChildAgentsReportSchema,
      `/api/conversations/${encodeURIComponent(conversationId)}/agents`,
    ),
    queryKey: conversationSideReadQueryKey(conversationId, "agents"),
    retry: false,
  });
}

const GROUP_LABELS: Record<AttentionGroup, string> = {
  done: "Done",
  needs_you: "Needs you",
  waiting: "Waiting",
  working: "Working",
};

// The heading sits on the row inset, like the rows of `DetailsList`.
const GROUP_HEADING_CLASS =
  "-mx-1.5 my-0 flex items-center gap-1 px-1.5 pt-1 pb-2 font-sans text-xs font-medium text-dashboard-text-muted";

/**
 * Read a child's attention from its tree state, run status, and last result.
 * A failed or blocked child needs the viewer, like a failed latest Turn on a
 * feed row. An archived child needs nothing.
 */
function childAgentAttention(agent: ConversationChildAgent): Attention {
  const { treeState } = agent;
  const status = childAgentStatusLabel(agent);
  return {
    group: agent.archivedAt
      ? "done"
      : treeState === "needs_you" || status === "failed" || status === "blocked"
        ? "needs_you"
        : treeState === "working" ||
            status === "running" ||
            status === "pending"
          ? "working"
          : agent.watching || status === "paused"
            ? "waiting"
            : "done",
    time: Date.parse(agent.updatedAt),
  };
}

/**
 * List the Threads of one Conversation in `attentionGroups` order, each
 * group under its label and count. Done starts collapsed: it needs nothing,
 * and it grows the most. Each row opens the Thread page. Archived Threads
 * stay hidden until the reader asks for them.
 */
export function ConversationThreads(props: {
  threads: readonly ConversationChildAgent[];
}) {
  const {
    action,
    items: threads,
    showArchived,
  } = useShowArchived(props.threads);
  const [doneOpen, setDoneOpen] = useState(false);
  const [archivedShown, setArchivedShown] = useState(showArchived);
  // Archived Threads sit under Done, so showing them opens it.
  if (archivedShown !== showArchived) {
    setArchivedShown(showArchived);
    if (showArchived) setDoneOpen(true);
  }
  return (
    <DetailsCard
      action={action}
      count={threads.length}
      label="Threads"
      title="Threads"
    >
      {threads.length > 0 ? (
        <div className="grid gap-2">
          {attentionGroups(threads, childAgentAttention).map(
            ({ group, rows }) => {
              const label = `${GROUP_LABELS[group]} · ${rows.length}`;
              if (group !== "done") {
                return (
                  <section aria-label={GROUP_LABELS[group]} key={group}>
                    <h4 className={GROUP_HEADING_CLASS}>{label}</h4>
                    <ThreadRows threads={rows} />
                  </section>
                );
              }
              return (
                <Collapsible
                  key={group}
                  onOpenChange={setDoneOpen}
                  open={doneOpen}
                  render={<section aria-label="Done" />}
                >
                  <h4 className="m-0">
                    <CollapsibleTrigger
                      render={
                        <Button
                          className={cn(
                            GROUP_HEADING_CLASS,
                            "group rounded-md hover:text-dashboard-text",
                          )}
                          size="bare"
                          variant="ghost"
                        />
                      }
                    >
                      {label}
                      <ChevronRight
                        aria-hidden="true"
                        className={dashboardDisclosureChevronClass}
                      />
                    </CollapsibleTrigger>
                  </h4>
                  <CollapsibleContent>
                    <ThreadRows threads={rows} />
                  </CollapsibleContent>
                </Collapsible>
              );
            },
          )}
        </div>
      ) : (
        <p className="m-0">Every Thread is archived.</p>
      )}
    </DetailsCard>
  );
}

function ThreadRows(props: { threads: readonly ConversationChildAgent[] }) {
  const feedThreads = useContext(FeedThreads);
  return (
    <DetailsList
      itemKey={(thread) => thread.conversationId}
      items={props.threads}
      renderItem={(thread) => (
        <ChildAgentRow
          agent={thread}
          // The report title is the task title, so the Thread's
          // own title wins. Archived Threads are not in the feed.
          title={feedThreads.get(thread.conversationId)?.displayTitle}
          to={conversationPath(thread.conversationId)}
        />
      )}
    />
  );
}

/**
 * List the Tasks of one Conversation. Tasks are background work, so the list
 * stays short, and a row opens the Task transcript beside this page.
 */
export function ConversationTasks(props: {
  onOpenTask(target: ConversationDrawerTarget): void;
  tasks: readonly ConversationChildAgent[];
}) {
  const { action, items: tasks } = useShowArchived(props.tasks);
  return (
    <DetailsCard
      action={action}
      count={tasks.length}
      label="Tasks"
      title="Tasks"
    >
      {tasks.length > 0 ? (
        <DetailsList
          itemKey={(task) => task.conversationId}
          items={tasks}
          renderItem={(task) => (
            <ChildAgentRow
              agent={task}
              onOpen={() =>
                props.onOpenTask({
                  conversationId: task.conversationId,
                  ...(task.redacted
                    ? undefined
                    : {
                        ...(task.name ? { agentName: task.name } : undefined),
                        label: task.title ?? task.name,
                      }),
                  status: childAgentStatusLabel(task),
                })
              }
            />
          )}
        />
      ) : (
        <p className="m-0">Every Task is archived.</p>
      )}
    </DetailsCard>
  );
}

/** Hide archived children until the reader asks for them. */
function useShowArchived(children: readonly ConversationChildAgent[]) {
  const [showArchived, setShowArchived] = useState(false);
  const archivedCount = children.filter((child) => child.archivedAt).length;
  return {
    action:
      archivedCount > 0 ? (
        <Button
          className="rounded-md px-1.5 py-0.5 text-xs"
          onClick={() => setShowArchived((value) => !value)}
          variant="ghost"
          size="bare"
        >
          {showArchived ? "Hide archived" : `Show archived (${archivedCount})`}
        </Button>
      ) : null,
    items: showArchived
      ? children
      : children.filter((child) => !child.archivedAt),
    showArchived,
  };
}

const statusIcons: Partial<Record<string, LucideIcon>> = {
  active: CircleDot,
  blocked: CircleAlert,
  completed: CircleCheck,
  done: CircleCheck,
  error: CircleX,
  failed: CircleX,
  paused: CirclePause,
};

const statusIconToneClass: Record<StatusChipTone, string> = {
  accent: "text-violet-300",
  danger: "text-rose-300",
  info: "text-cyan-300",
  neutral: "text-dashboard-text-faint",
  success: "text-emerald-300",
  warning: "text-amber-300",
};

/**
 * Mark a child agent with one icon and an audible label. A wait on the
 * viewer, work in its tree, or a Watch outranks how its own run ended, as
 * in its group.
 */
function ChildAgentStatusIcon(props: { agent: ConversationChildAgent }) {
  const { archivedAt, treeState, watching } = props.agent;
  const status = childAgentStatusLabel(props.agent);
  if (!archivedAt && treeState === "needs_you") {
    return <ConversationStateIcon state="needs_you" />;
  }
  const settled = !archivedAt && status !== "failed" && status !== "blocked";
  // A nested child can still work after this child's own run ended.
  if (settled && treeState === "working" && status !== "running") {
    return <ConversationStateIcon state="working" />;
  }
  if (settled && treeState === "done" && watching) {
    return <ConversationStateIcon state="watching" />;
  }
  const archived = Boolean(archivedAt);
  // A done result shows like a completed transcript row. `done` stays out of
  // `statusTones`, because the drawer shows a done Conversation as neutral.
  const tone = status === "done" ? "success" : subagentStatusTone(status);
  const Icon = archived
    ? Archive
    : status === "running"
      ? Spinner
      : (statusIcons[status] ?? Circle);
  return (
    <>
      <Icon
        aria-hidden="true"
        className={cn(
          "size-3.5",
          archived ? "text-dashboard-text-faint" : statusIconToneClass[tone],
        )}
      />
      <span className="sr-only">{archived ? "archived" : status}</span>
    </>
  );
}

/**
 * Show one child agent as a dense row: status, title, and run time first,
 * then agent name and cost. The row text is the accessible name, so status
 * and title stay audible. A Thread row links to its page; a Task row opens
 * its transcript.
 */
function ChildAgentRow(props: {
  agent: ConversationChildAgent;
  onOpen?(): void;
  /** The Conversation's own title, when known. It wins over the report title. */
  title?: string | undefined;
  to?: string;
}) {
  const { agent } = props;
  const headline = props.title ?? agent.title;
  const kindLabel = agent.kind === "thread" ? "Thread" : "Task";
  const name = agent.redacted
    ? `Private ${kindLabel.toLowerCase()}`
    : agent.name;
  // Totals include this child's own children. Say so, so the row does not
  // read as the work of this child alone.
  const nested = agent.childAgentTotals?.count;
  const meta = [
    headline ? name : "",
    formatUsageTotal(agent.cumulativeUsage),
    formatConversationCostTotal(agent.cumulativeUsage, agent.auxiliaryCosts),
    nested ? `+${nested} nested` : "",
  ].filter(Boolean);

  return (
    <DetailsRow
      icon={<ChildAgentStatusIcon agent={agent} />}
      meta={formatRuntime(agent.cumulativeDurationMs)}
      onClick={props.onOpen}
      title={headline ?? name ?? kindLabel}
      to={props.to}
      tooltip={`Updated ${formatTime(agent.updatedAt, {
        dateStyle: "medium",
        timeStyle: "short",
      })}`}
    >
      {meta.length > 0 || agent.redacted ? (
        <DetailsRowLine className="flex items-center gap-1.5">
          {agent.redacted ? (
            <LockKeyhole aria-hidden="true" className="size-3 shrink-0" />
          ) : null}
          <span className="min-w-0 truncate">{meta.join(" · ")}</span>
        </DetailsRowLine>
      ) : null}
    </DetailsRow>
  );
}
