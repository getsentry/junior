import { GitFork } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { Field, FieldError, FieldLabel } from "../components/ui/field";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "../components/ui/dialog";
import { useSheet } from "../components/ui/useSheet";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { DashboardApiError } from "../http";
import { conversationPath } from "./conversationRoutes";
import { useForkConversation } from "./queries";

type ForkTarget = { conversationId: string; messageId: string };

/** Open the fork dialog for one assistant reply. */
export function ForkConversationButton(props: ForkTarget) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon"
              aria-label="Fork after this message"
              onClick={() => setOpen(true)}
            >
              <GitFork size={14} aria-hidden="true" />
            </Button>
          }
        />
        <TooltipContent size="compact">Fork after this message</TooltipContent>
      </Tooltip>
      {open ? (
        <ForkConversationDialog {...props} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

function ForkConversationDialog(props: ForkTarget & { onClose(): void }) {
  const inputId = useId();
  const errorId = `${inputId}-error`;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [message, setMessage] = useState("");
  const navigate = useNavigate();
  const fork = useForkConversation(props.conversationId);
  const sheet = useSheet(props.onClose, inputRef);
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
  const error = fork.error
    ? (fork.error instanceof DashboardApiError && fork.error.apiError) ||
      "Could not fork the conversation. Try again."
    : undefined;
  return (
    <Dialog
      {...sheet.rootProps}
      onOpenChange={(nextOpen, details) => {
        // A pending fork must finish so its navigation is not lost.
        if (!nextOpen && fork.isPending) {
          details.cancel();
          return;
        }
        sheet.rootProps.onOpenChange(nextOpen, details);
      }}
    >
      <DialogContent {...sheet.contentProps}>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <DialogTitle>Fork Conversation</DialogTitle>
          <Field>
            <FieldLabel htmlFor={inputId}>Message</FieldLabel>
            <Textarea
              ref={inputRef}
              id={inputId}
              aria-describedby={error ? errorId : undefined}
              aria-invalid={error ? true : undefined}
              className="min-h-24 leading-relaxed"
              placeholder="Message Junior…"
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
            <FieldError id={errorId}>{error}</FieldError>
          </Field>
          <DialogFooter>
            <DialogClose
              disabled={fork.isPending}
              render={<Button>Cancel</Button>}
            />
            <Button
              variant="primary"
              type="submit"
              disabled={!message.trim() || fork.isPending}
            >
              {fork.isPending ? "Forking…" : "Fork and send"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
