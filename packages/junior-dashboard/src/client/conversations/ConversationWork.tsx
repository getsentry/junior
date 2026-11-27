import {
  Circle,
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  Ellipsis,
  Eye,
  type LucideIcon,
} from "lucide-react";
import { type ReactNode, useContext, useState } from "react";
import type {
  ConversationChildAgent,
  ConversationTodo,
  ConversationWatch,
} from "@sentry/junior/api/schema";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Spinner } from "../components/ui/spinner";
import { DisplayText } from "../display-text/DisplayText";
import { cn } from "../styles";
import { formatRelativeTime } from "../time";
import { ArchiveChildDialog } from "./ArchiveChildDialog";
import { useArchiveConversation } from "./conversationArchive";
import {
  childAgentStatusLabel,
  useConversationChildAgents,
} from "./ConversationChildAgents";
import type { ConversationDrawerTarget } from "./ConversationDrawer";
import { conversationPath } from "./conversationRoutes";
import {
  todoActions,
  useConversationTodos,
  useSetTodoStatus,
} from "./ConversationTodos";
import {
  useCancelConversationWatch,
  useConversationWatches,
} from "./ConversationWatches";
import {
  conversationWorkItems,
  type WorkItem,
  type WorkState,
} from "./conversationWorkItems";
import { DetailsRow, DetailsRowLine, DetailsSection } from "./DetailsList";
import { FeedThreads } from "./feedThreads";

const stateLabels: Record<WorkState, string> = {
  blocked: "Blocked",
  done: "Done",
  failed: "Failed",
  running: "Running",
  todo: "To do",
  waiting: "Waiting",
};

const stateIcons: Record<Exclude<WorkState, "running">, LucideIcon> = {
  blocked: CircleAlert,
  done: CircleCheck,
  failed: CircleX,
  todo: Circle,
  waiting: Clock,
};

/**
 * Mark where one piece of work stands. Only running work has the accent,
 * and only blocked or failed work has the primary text color, so the rows
 * that need a look stand out without status colors. Work that waits on a
 * Watch has the sidebar's eye.
 */
function WorkStateIcon(props: { state: WorkState; watching?: boolean }) {
  const watching = props.state === "waiting" && props.watching;
  const label = watching ? "Watching" : stateLabels[props.state];
  if (props.state === "running") {
    return (
      <Spinner aria-label={label} className="size-4 text-dashboard-accent" />
    );
  }
  const Icon = watching ? Eye : stateIcons[props.state];
  return (
    <Icon
      aria-label={label}
      className={cn(
        "size-4",
        props.state === "blocked" || props.state === "failed"
          ? "text-dashboard-text"
          : "text-dashboard-text-muted",
      )}
      role="img"
    />
  );
}

/**
 * List the work of one Conversation in one section: its To-dos, its child
 * Conversations, and its Watches and Timers, by state. Finished work hides
 * behind "Show finished". Participants change To-dos, cancel Watches, and
 * archive children from each row's menu.
 */
export function ConversationWork(props: {
  canEdit: boolean;
  conversationId: string;
  onOpenTask(target: ConversationDrawerTarget): void;
  /** The viewer's own open To-dos, which Needs you shows instead. */
  viewerTodoIds: ReadonlySet<number>;
}) {
  const children =
    useConversationChildAgents(props.conversationId).data?.agents ?? [];
  const todos = useConversationTodos(props.conversationId).data?.todos ?? [];
  const watches =
    useConversationWatches(props.conversationId).data?.watches ?? [];
  const items = conversationWorkItems({
    children,
    todos,
    viewerTodoIds: props.viewerTodoIds,
    watches,
  });
  const row = (item: WorkItem) => (
    <WorkRow
      canEdit={props.canEdit}
      conversationId={props.conversationId}
      item={item}
      key={item.key}
      onOpenTask={props.onOpenTask}
    />
  );
  return (
    <DetailsSection
      finished={items.filter((item) => item.state === "done").map(row)}
      rows={items.filter((item) => item.state !== "done").map(row)}
      title="Work"
    />
  );
}

function WorkRow(props: {
  canEdit: boolean;
  conversationId: string;
  item: WorkItem;
  onOpenTask(target: ConversationDrawerTarget): void;
}) {
  const { item } = props;
  const feedThreads = useContext(FeedThreads);
  if (item.kind === "watch") {
    return (
      <DetailsRow
        href={item.watch.url}
        // A Timer keeps the clock. An event Watch has the eye.
        icon={
          <WorkStateIcon state={item.state} watching={!item.watch.firesAt} />
        }
        menu={
          props.canEdit ? (
            <WatchMenu
              conversationId={props.conversationId}
              watch={item.watch}
            />
          ) : null
        }
        title={watchTitle(item.watch)}
        tooltip={watchTooltip(item.watch)}
      />
    );
  }
  const { child, childWatches } = item;
  const open = child ? childOpener(child, props.onOpenTask) : undefined;
  const icon = (
    <WorkStateIcon
      state={item.state}
      watching={
        child !== undefined &&
        child.status !== "paused" &&
        (child.watching || childWatches.length > 0)
      }
    />
  );
  const watchItems = props.canEdit ? (
    <WatchCancelItems
      conversationId={props.conversationId}
      watches={childWatches}
    />
  ) : null;
  if (item.kind === "child") {
    const lastSeenAt = feedThreads.get(item.child.conversationId)?.lastSeenAt;
    return (
      <DetailsRow
        icon={icon}
        menu={
          props.canEdit &&
          !item.child.redacted &&
          (lastSeenAt || watchItems) ? (
            <ChildMenu child={item.child} lastSeenAt={lastSeenAt}>
              {watchItems}
            </ChildMenu>
          ) : null
        }
        title={
          (!item.child.redacted &&
            feedThreads.get(item.child.conversationId)?.displayTitle) ||
          childTitle(item.child)
        }
        {...open}
      />
    );
  }
  const { todo } = item;
  return (
    <DetailsRow
      icon={icon}
      menu={
        props.canEdit && !todo.redacted ? (
          <TodoMenu conversationId={props.conversationId} todo={todo}>
            {watchItems}
          </TodoMenu>
        ) : null
      }
      title={todo.title ?? "Private To-do"}
      tooltip={todo.changedBy ? `Changed by ${todo.changedBy}` : undefined}
      {...open}
    >
      {todo.notes ? (
        <DetailsRowLine>
          <DisplayText inline text={todo.notes} />
        </DetailsRowLine>
      ) : todo.assignee.kind === "user" && todo.assignee.name ? (
        <DetailsRowLine>Assigned to {todo.assignee.name}</DetailsRowLine>
      ) : null}
    </DetailsRow>
  );
}

function watchTitle(watch: ConversationWatch): string {
  const resource = `${watch.namespace} ${watch.resourceType.replaceAll("_", " ")}`;
  return watch.intent ?? watch.label ?? `Private ${resource}`;
}

/** Name the resource of a Watch and when it fires or expires. */
function watchTooltip(watch: ConversationWatch): string {
  const when = watch.firesAt
    ? `Fires ${formatRelativeTime(watch.firesAt)}`
    : `Expires ${formatRelativeTime(watch.expiresAt)}`;
  return watch.label ? `${watch.label} · ${when}` : when;
}

function childTitle(child: ConversationChildAgent): string {
  const kind = child.kind === "thread" ? "Thread" : "Task";
  if (child.redacted) return `Private ${kind.toLowerCase()}`;
  return child.title ?? child.name ?? kind;
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

/** A row's menu: one trigger that shows on hover or focus. */
function RowMenu(props: {
  children: ReactNode;
  disabled?: boolean;
  label: string;
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        aria-label={props.label}
        className="grid size-6 place-items-center rounded-md bg-dashboard-surface-panel text-dashboard-text-muted transition-colors hover:bg-dashboard-surface-hover hover:text-dashboard-text focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus"
        disabled={props.disabled}
      >
        <Ellipsis aria-hidden="true" size={15} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36 max-w-72">
        {props.children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TodoMenu(props: {
  /** More entries, such as Cancel for the child's Watches. */
  children?: ReactNode;
  conversationId: string;
  todo: ConversationTodo;
}) {
  const setStatus = useSetTodoStatus(props.conversationId, props.todo.id);
  return (
    <RowMenu
      disabled={setStatus.isPending}
      label={`Change ${props.todo.title ?? "To-do"}`}
    >
      {todoActions[props.todo.status].map((action) => (
        <DropdownMenuItem
          key={action.status}
          onClick={() => setStatus.mutate(action.status)}
        >
          {action.label}
        </DropdownMenuItem>
      ))}
      {props.children}
    </RowMenu>
  );
}

function WatchMenu(props: {
  conversationId: string;
  watch: ConversationWatch;
}) {
  const cancel = useCancelConversationWatch(props.conversationId);
  return (
    <RowMenu label={`Change ${watchTitle(props.watch)}`}>
      <DropdownMenuItem onClick={() => cancel.mutate(props.watch)}>
        Cancel
      </DropdownMenuItem>
    </RowMenu>
  );
}

/** Offer Cancel for each Watch that a child owns. */
function WatchCancelItems(props: {
  conversationId: string;
  watches: readonly ConversationWatch[];
}) {
  const cancel = useCancelConversationWatch(props.conversationId);
  return props.watches.map((watch) => (
    <DropdownMenuItem key={watch.id} onClick={() => cancel.mutate(watch)}>
      Cancel {watchTitle(watch)}
    </DropdownMenuItem>
  ));
}

/**
 * Archive a child after a confirm, or restore it at once. Archive needs the
 * child's last activity, which only a feed Thread has, so a Task is
 * archived from its own page.
 */
function ChildMenu(props: {
  /** More entries, such as Cancel for the child's Watches. */
  children?: ReactNode;
  child: ConversationChildAgent;
  lastSeenAt: string | undefined;
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
      <RowMenu
        disabled={archive.isPending}
        label={`Change ${childTitle(child)}`}
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
      </RowMenu>
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
