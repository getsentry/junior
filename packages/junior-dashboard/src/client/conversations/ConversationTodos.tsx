import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getDashboardAgentName } from "../agentName";
import {
  Circle,
  CircleCheck,
  CircleDashed,
  CircleX,
  Ellipsis,
  LockKeyhole,
  type LucideIcon,
} from "lucide-react";
import {
  conversationTodoSchema,
  conversationTodosReportSchema,
  type ConversationTodo,
  type TodoStatusBody,
} from "@sentry/junior/api/schema";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { DisplayText } from "../display-text/DisplayText";
import { patch } from "../http";
import { revalidatedJsonQuery } from "../revalidation";
import { cn } from "../styles";
import { conversationSideReadQueryKey } from "./conversationSideReads";
import {
  DetailsCard,
  DetailsList,
  DetailsRow,
  DetailsRowLine,
} from "./DetailsList";

/** Load the open To-dos of one Conversation, then the latest closed ones. */
export function useConversationTodos(conversationId: string) {
  return useQuery({
    queryFn: revalidatedJsonQuery(
      conversationTodosReportSchema,
      `/api/conversations/${encodeURIComponent(conversationId)}/todos`,
    ),
    queryKey: conversationSideReadQueryKey(conversationId, "todos"),
    retry: false,
  });
}

const statusIcons: Record<ConversationTodo["status"], LucideIcon> = {
  open: Circle,
  in_progress: CircleDashed,
  done: CircleCheck,
  dropped: CircleX,
};

const statusLabels: Record<ConversationTodo["status"], string> = {
  open: "Open",
  in_progress: "In progress",
  done: "Done",
  dropped: "Dropped",
};

function assigneeLabel(todo: ConversationTodo): string {
  const { assignee } = todo;
  if (assignee.kind === "self") return getDashboardAgentName();
  if (assignee.kind === "agent") return assignee.name ?? "Child agent";
  return assignee.name ?? "Person";
}

/**
 * Show the To-dos of one Conversation: open ones, then recently closed ones,
 * each with its status and assignee. Participants can start, close, or
 * reopen a To-do. The agent sees that change on its next Turn.
 */
export function ConversationTodos(props: {
  canEdit: boolean;
  conversationId: string;
}) {
  const todos = useConversationTodos(props.conversationId).data?.todos ?? [];
  if (todos.length === 0) return null;
  const open = todos.filter(
    (todo) => todo.status === "open" || todo.status === "in_progress",
  ).length;
  return (
    <DetailsCard count={open} title="To-dos">
      <DetailsList
        itemKey={(todo) => String(todo.id)}
        items={todos}
        renderItem={(todo) => (
          <TodoRow
            canEdit={props.canEdit && todo.redacted !== true}
            conversationId={props.conversationId}
            todo={todo}
          />
        )}
      />
    </DetailsCard>
  );
}

function TodoRow(props: {
  canEdit: boolean;
  conversationId: string;
  todo: ConversationTodo;
}) {
  const { todo } = props;
  const Icon = todo.redacted ? LockKeyhole : statusIcons[todo.status];
  const closed = todo.status === "done" || todo.status === "dropped";
  const row = (
    <DetailsRow
      icon={
        <Icon
          aria-label={statusLabels[todo.status]}
          className={cn(
            "size-3.5",
            // Same tone as the running Thread and Task status icons.
            todo.status === "in_progress" && "text-dashboard-accent",
            closed && "text-dashboard-text-faint",
          )}
          role="img"
        />
      }
      meta={assigneeLabel(todo)}
      title={
        <span
          className={cn(closed && "text-dashboard-text-muted line-through")}
        >
          {todo.title ?? "Private To-do"}
        </span>
      }
      tooltip={todo.changedBy ? `Changed by ${todo.changedBy}` : undefined}
    >
      {todo.notes ? (
        <DetailsRowLine className="line-clamp-2 break-words">
          <DisplayText inline text={todo.notes} />
        </DetailsRowLine>
      ) : null}
    </DetailsRow>
  );
  if (!props.canEdit) return row;
  return (
    <div className="flex min-w-0 items-start gap-0.5">
      <div className="min-w-0 flex-1">{row}</div>
      <TodoMenu conversationId={props.conversationId} todo={todo} />
    </div>
  );
}

const todoActions: Record<
  ConversationTodo["status"],
  Array<{ label: string; status: TodoStatusBody["status"] }>
> = {
  open: [
    { label: "Start", status: "in_progress" },
    { label: "Mark done", status: "done" },
    { label: "Drop", status: "dropped" },
  ],
  in_progress: [
    { label: "Mark done", status: "done" },
    { label: "Stop", status: "open" },
    { label: "Drop", status: "dropped" },
  ],
  done: [{ label: "Reopen", status: "open" }],
  dropped: [{ label: "Reopen", status: "open" }],
};

function TodoMenu(props: { conversationId: string; todo: ConversationTodo }) {
  const setStatus = useSetTodoStatus(props.conversationId, props.todo.id);
  const actions = todoActions[props.todo.status];
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        aria-label={`Change ${props.todo.title ?? "To-do"}`}
        className="grid size-8 shrink-0 place-items-center rounded-md text-dashboard-text-muted transition-colors hover:bg-dashboard-surface-hover hover:text-dashboard-text focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus"
        disabled={setStatus.isPending}
      >
        <Ellipsis aria-hidden="true" size={15} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36">
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.status}
            onClick={() => setStatus.mutate(action.status)}
          >
            {action.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function useSetTodoStatus(conversationId: string, todoId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (status: TodoStatusBody["status"]) =>
      patch(
        conversationTodoSchema,
        `/api/conversations/${encodeURIComponent(conversationId)}/todos/${todoId}`,
        { status },
      ),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: conversationSideReadQueryKey(conversationId, "todos"),
      }),
  });
}
