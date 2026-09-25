import { GitFork } from "lucide-react";
import { useId, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { forkConversationResponseSchema } from "@sentry/junior/api/schema";
import { Button } from "../components/Button";
import { Drawer } from "../components/Drawer";
import { DashboardApiError, post } from "../http";
import { conversationPath } from "./conversationRoutes";
import { TranscriptText } from "./TranscriptText";

type ForkTarget = { conversationId: string; messageId: string; text: string };

/** Offer the same completed-reply fork action in the transcript and event log. */
export function ForkConversationButton(props: ForkTarget) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="icon"
        aria-label="Fork after this message"
        title="Fork after this message"
        onClick={() => setOpen(true)}
      >
        <GitFork size={14} aria-hidden="true" />
      </Button>
      {open
        ? createPortal(
            <ForkConversationDialog
              {...props}
              onClose={() => setOpen(false)}
            />,
            document.body,
          )
        : null}
    </>
  );
}

function ForkConversationDialog(props: ForkTarget & { onClose(): void }) {
  const titleId = useId();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fork = useMutation({
    mutationFn: () =>
      post(
        forkConversationResponseSchema,
        `/api/conversations/${encodeURIComponent(props.conversationId)}/forks`,
        {
          cutoff: { kind: "message", messageId: props.messageId },
          idempotencyKey,
        },
      ),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({
        queryKey: ["dashboard", "conversations"],
      });
      props.onClose();
      navigate(conversationPath(result.conversationId));
    },
  });
  return (
    <Drawer
      closeLabel="Close fork dialog"
      dismissLabel="Dismiss fork dialog"
      header={
        <h2 id={titleId} className="m-0 text-lg font-semibold">
          Fork Conversation
        </h2>
      }
      titleId={titleId}
      openKey={idempotencyKey}
      onClose={() => {
        if (!fork.isPending) props.onClose();
      }}
      width="narrow"
    >
      <div className="grid gap-4 text-sm">
        <p className="m-0">
          Start a separate conversation with the retained agent history through
          this reply. The original conversation stays unchanged.
        </p>
        <blockquote className="m-0 max-h-48 overflow-auto border-l-2 border-dashboard-border pl-3 text-dashboard-text-muted">
          <TranscriptText role="assistant" text={props.text} />
        </blockquote>
        <p className="m-0">
          Sandbox files and active work are not copied. The fork uses a fresh
          Sandbox when needed and keeps the source visibility.
        </p>
        <p className="m-0">
          Open the fork, then send your new instruction. Creating the fork does
          not start a run.
        </p>
        {fork.error ? (
          <p role="alert" className="m-0 text-red-300">
            {fork.error instanceof DashboardApiError
              ? (fork.error.apiError ??
                "Could not fork the conversation. Try again.")
              : "Could not fork the conversation. Try again."}
          </p>
        ) : null}
        <Button disabled={fork.isPending} onClick={() => fork.mutate()}>
          {fork.isPending ? "Creating fork…" : "Create fork"}
        </Button>
      </div>
    </Drawer>
  );
}
