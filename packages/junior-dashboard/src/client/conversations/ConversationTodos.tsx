import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  conversationTodoSchema,
  conversationTodosReportSchema,
  type ConversationTodo,
  type TodoStatusBody,
} from "@sentry/junior/api/schema";

import { patch } from "../http";
import { revalidatedJsonQuery } from "../revalidation";
import { conversationSideReadQueryKey } from "./conversationSideReads";

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
export const todoActions: Record<
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

/** Set the status of one To-do, then read the To-dos again. */
export function useSetTodoStatus(conversationId: string, todoId: number) {
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
