import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LockKeyhole } from "lucide-react";
import { useContext } from "react";
import {
  conversationTodoSchema,
  conversationTodosReportSchema,
  type ConversationTodo,
  type TodoStatusBody,
} from "@sentry/junior/api/schema";

import { getDashboardAgentName } from "../agentName";
import { DropdownMenuItem } from "../components/ui/dropdown-menu";
import { DisplayText } from "../display-text/DisplayText";
import { patch } from "../http";
import { revalidatedJsonQuery } from "../revalidation";
import { childTitle } from "./ConversationAgents";
import { useConversationChildAgents } from "./ConversationChildAgents";
import { conversationSideReadQueryKey } from "./conversationSideReads";
import {
  DetailsRow,
  DetailsRowLine,
  DetailsRowMenu,
  DetailsSection,
} from "./DetailsList";
import { FeedThreads } from "./feedThreads";
import { todoStatusIcons } from "./todoStatusIcons";

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

/** The status changes that a Participant can make from each status. */
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
    { label: "Mark not started", status: "open" },
    { label: "Drop", status: "dropped" },
  ],
  done: [{ label: "Reopen", status: "open" }],
  dropped: [{ label: "Reopen", status: "open" }],
};

const statusLabels: Record<ConversationTodo["status"], string> = {
  open: "Not started",
  in_progress: "In progress",
  done: "Done",
  dropped: "Dropped",
};

/**
 * Name who owns a To-do: "You", a person, the bot, or the child agent by
 * its title.
 */
export function todoOwner(todo: ConversationTodo, agentTitle?: string): string {
  const { assignee } = todo;
  if (assignee.kind === "self") return getDashboardAgentName();
  if (assignee.kind === "agent") {
    return agentTitle ?? assignee.name ?? "Child agent";
  }
  if (assignee.viewer) return "You";
  return assignee.name ?? "Person";
}

/**
 * List the To-dos of one Conversation, each with its owner and notes. The
 * viewer's open To-dos that Needs you shows stay out. Done and dropped
 * To-dos hide behind "Show finished". Participants change a To-do's status
 * from its menu.
 */
export function ConversationTodoList(props: {
  canEdit: boolean;
  conversationId: string;
  /** The viewer's To-dos that Needs you shows. */
  needsYouTodoIds: ReadonlySet<number>;
}) {
  const todos = useConversationTodos(props.conversationId).data?.todos ?? [];
  const children =
    useConversationChildAgents(props.conversationId).data?.agents ?? [];
  const feedThreads = useContext(FeedThreads);
  const row = (todo: ConversationTodo) => {
    const { assignee } = todo;
    const child =
      assignee.kind === "agent"
        ? children.find(
            (candidate) => candidate.conversationId === assignee.conversationId,
          )
        : undefined;
    return (
      <TodoRow
        canEdit={props.canEdit && !todo.redacted}
        conversationId={props.conversationId}
        key={todo.id}
        owner={todoOwner(
          todo,
          child &&
            childTitle(
              child,
              feedThreads.get(child.conversationId)?.displayTitle,
            ),
        )}
        todo={todo}
      />
    );
  };
  const closed = (todo: ConversationTodo) =>
    todo.status === "done" || todo.status === "dropped";
  return (
    <DetailsSection
      finished={todos.filter(closed).map(row)}
      rows={todos
        .filter((todo) => !closed(todo) && !props.needsYouTodoIds.has(todo.id))
        .map(row)}
      title="To-dos"
    />
  );
}

function TodoRow(props: {
  canEdit: boolean;
  conversationId: string;
  owner: string;
  todo: ConversationTodo;
}) {
  const { todo } = props;
  const setStatus = useSetTodoStatus(props.conversationId, todo.id);
  const title = todo.title ?? "Private To-do";
  const Icon = todo.redacted ? LockKeyhole : todoStatusIcons[todo.status];
  return (
    <DetailsRow
      icon={
        <Icon
          aria-label={todo.redacted ? "Private" : statusLabels[todo.status]}
          className="size-4 text-dashboard-text-muted"
          role="img"
        />
      }
      menu={
        props.canEdit ? (
          <DetailsRowMenu
            disabled={setStatus.isPending}
            label={`Change ${title}`}
          >
            {todoActions[todo.status].map((action) => (
              <DropdownMenuItem
                key={action.status}
                onClick={() => setStatus.mutate(action.status)}
              >
                {action.label}
              </DropdownMenuItem>
            ))}
          </DetailsRowMenu>
        ) : null
      }
      title={title}
      tooltip={todo.changedBy ? `Changed by ${todo.changedBy}` : undefined}
    >
      <DetailsRowLine>
        {props.owner}
        {todo.notes ? (
          <>
            {" · "}
            <DisplayText inline text={todo.notes} />
          </>
        ) : null}
      </DetailsRowLine>
    </DetailsRow>
  );
}

/** Set the status of one To-do, then read the To-dos again. */
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
