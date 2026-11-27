import {
  Circle,
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  Ellipsis,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
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
 * that need a look stand out without status colors.
 */
function WorkStateIcon(props: { state: WorkState }) {
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
  const icon = <WorkStateIcon state={item.state} />;
  if (item.kind === "watch") {
    return (
      <DetailsRow
        href={item.watch.url}
        icon={icon}
        menu={
          props.canEdit ? (
            <WatchMenu
              conversationId={props.conversationId}
              watch={item.watch}
            />
          ) : null
        }
        title={watchTitle(item.watch)}
        tooltip={item.watch.label}
      />
    );
  }
  const child = item.child;
  const open = child ? childOpener(child, props.onOpenTask) : undefined;
  if (item.kind === "child") {
    return (
      <DetailsRow
        icon={icon}
        menu={
          props.canEdit && !item.child.redacted ? (
            <ChildMenu child={item.child} />
          ) : null
        }
        title={childTitle(item.child)}
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
          <TodoMenu conversationId={props.conversationId} todo={todo} />
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
      <DropdownMenuContent align="end" className="w-36">
        {props.children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TodoMenu(props: { conversationId: string; todo: ConversationTodo }) {
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

function ChildMenu(props: { child: ConversationChildAgent }) {
  const archive = useArchiveConversation(props.child.conversationId);
  const archived = Boolean(props.child.archivedAt);
  return (
    <RowMenu
      disabled={archive.isPending}
      label={`Change ${childTitle(props.child)}`}
    >
      <DropdownMenuItem
        onClick={() =>
          archive.mutate({
            archived: !archived,
            lastSeenAt: props.child.updatedAt,
          })
        }
      >
        {archived ? "Restore" : "Archive"}
      </DropdownMenuItem>
    </RowMenu>
  );
}
