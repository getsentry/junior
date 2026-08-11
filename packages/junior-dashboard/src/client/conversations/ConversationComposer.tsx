import {
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { Send } from "lucide-react";

import { Button } from "../components/Button";
import { cn } from "../styles";

/** Render the dashboard message composer for a new or existing conversation. */
export function ConversationComposer(props: {
  /** Squash top corners when a pending mailbox stack sits flush above. */
  attached?: boolean;
  error?: string;
  label: string;
  pending: boolean;
  submitLabel: string;
  onSubmit(message: string, idempotencyKey: string): Promise<void>;
}) {
  const [message, setMessage] = useState("");
  const id = useId();
  const submission = useRef({ idempotencyKey: crypto.randomUUID(), text: "" });

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = message.trim();
    if (!text || props.pending) return;
    if (submission.current.text !== text) {
      submission.current = { idempotencyKey: crypto.randomUUID(), text };
    }
    try {
      await props.onSubmit(text, submission.current.idempotencyKey);
      setMessage("");
      submission.current = { idempotencyKey: crypto.randomUUID(), text: "" };
    } catch {
      // The parent renders the mutation error and keeps the draft for retry.
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <form
      className={cn(
        "overflow-hidden border border-white/[0.09] bg-white/[0.035] focus-within:border-cyan-300/35 focus-within:ring-1 focus-within:ring-cyan-300/25",
        props.attached ? "rounded-b-lg rounded-t-none" : "rounded-lg",
      )}
      onSubmit={submit}
    >
      <label className="sr-only" htmlFor={id}>
        {props.label}
      </label>
      <textarea
        className="min-h-24 w-full resize-y border-0 bg-transparent px-3.5 py-3 font-mono text-sm leading-relaxed text-dashboard-text outline-none placeholder:text-dashboard-text-muted/65 disabled:opacity-60"
        disabled={props.pending}
        id={id}
        maxLength={32_000}
        onChange={(event) => setMessage(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Message Junior…"
        value={message}
      />
      <div className="flex min-w-0 items-center justify-between gap-3 border-t border-white/[0.07] bg-black/15 px-3 py-2">
        <div
          className={cn(
            "min-w-0 font-mono text-xs leading-relaxed",
            props.error
              ? "text-red-300/80"
              : "text-dashboard-text-muted",
          )}
        >
          {props.error ?? "Enter to send · Shift+Enter for a new line"}
        </div>
        <Button disabled={!message.trim() || props.pending} type="submit">
          <Send aria-hidden="true" size={14} />
          {props.pending ? "Sending…" : props.submitLabel}
        </Button>
      </div>
    </form>
  );
}
