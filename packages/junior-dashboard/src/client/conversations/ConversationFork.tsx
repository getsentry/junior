import { createContext, useContext, useRef, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { GitFork } from "lucide-react";
import { forkConversationResponseSchema } from "@sentry/junior/api/schema";
import { DashboardApiError, post } from "../http";
import { Button } from "../components/Button";
import { conversationPath } from "./conversationRoutes";
import type { TranscriptViewMessage } from "../types";

const ForkContext = createContext<
  { pending: boolean; fork(messageSeq: number): void } | undefined
>(undefined);

/** Own fork requests and navigation for the main web transcript only. */
export function ConversationForkProvider(props: {
  children: ReactNode;
  conversationId: string;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const attempts = useRef(new Map<number, string>());
  const mutation = useMutation({
    mutationFn: (messageSeq: number) => {
      let idempotencyKey = attempts.current.get(messageSeq);
      if (!idempotencyKey) {
        idempotencyKey = crypto.randomUUID();
        attempts.current.set(messageSeq, idempotencyKey);
      }
      return post(
        forkConversationResponseSchema,
        `/api/conversations/${encodeURIComponent(props.conversationId)}/fork`,
        { messageSeq, idempotencyKey },
      );
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({
        queryKey: ["dashboard", "conversations"],
      });
      navigate(conversationPath(result.conversationId), {
        state: { forkPrefill: result.prefill },
      });
    },
  });
  return (
    <ForkContext.Provider
      value={{ pending: mutation.isPending, fork: mutation.mutate }}
    >
      {mutation.error ? (
        <p role="alert" className="text-sm text-rose-300">
          {mutation.error instanceof DashboardApiError &&
          mutation.error.status < 500
            ? (mutation.error.apiError ?? "Could not fork this conversation.")
            : "Could not fork. Try again."}
        </p>
      ) : null}
      {props.children}
    </ForkContext.Provider>
  );
}

/** Offer a fork on saved user and assistant Messages, not pending or redacted rows. */
export function ConversationForkButton({
  message,
}: {
  message: TranscriptViewMessage;
}) {
  const context = useContext(ForkContext);
  if (
    !context ||
    message.pending ||
    !message.messageId ||
    (message.role !== "assistant" && message.role !== "user")
  )
    return null;
  return (
    <Button
      aria-label="Fork conversation from this message"
      className="!size-6"
      disabled={context.pending}
      onClick={() => context.fork(message.sourceSeq)}
      size="icon"
      title="Fork conversation"
    >
      <GitFork aria-hidden="true" size={14} />
    </Button>
  );
}
