import { GitFork } from "lucide-react";
import { useId, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import { Button } from "../components/Button";
import { Drawer } from "../components/Drawer";
import { Field } from "../components/Field";
import { TextArea } from "../components/TextInput";
import { DashboardApiError } from "../http";
import { conversationPath } from "./conversationRoutes";
import { useForkConversation } from "./queries";

type ForkTarget = { conversationId: string; messageId: string };

/** Open the fork dialog for one assistant reply. */
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
  const inputId = useId();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [message, setMessage] = useState("");
  const navigate = useNavigate();
  const fork = useForkConversation(props.conversationId);
  const submit = () => {
    if (!message.trim() || fork.isPending) return;
    fork.mutate(
      { idempotencyKey, message, messageId: props.messageId },
      {
        onSuccess: (accepted) => {
          props.onClose();
          navigate(conversationPath(accepted.conversationId));
        },
      },
    );
  };
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
      <form
        className="grid gap-4 text-sm"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <p className="m-0">
          Copy this conversation through this reply into a new conversation, and
          continue there. The original conversation does not change. Sandbox
          files and active work are not copied.
        </p>
        <Field htmlFor={inputId} label="Message">
          <TextArea
            id={inputId}
            prose
            autoFocus
            className="min-h-28"
            placeholder="What should Junior do differently?"
            value={message}
            disabled={fork.isPending}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              // Same keys as the composer: Enter sends, Shift+Enter adds a line.
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                submit();
              }
            }}
          />
        </Field>
        {fork.error ? (
          <p role="alert" className="m-0 text-red-300">
            {(fork.error instanceof DashboardApiError && fork.error.apiError) ||
              "Could not fork the conversation. Try again."}
          </p>
        ) : null}
        <Button
          tone="primary"
          type="submit"
          disabled={!message.trim() || fork.isPending}
        >
          {fork.isPending ? "Forking…" : "Fork and send"}
        </Button>
      </form>
    </Drawer>
  );
}
