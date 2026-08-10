import {
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { Send } from "lucide-react";

import { Button } from "../components/Button";

/** Render the dashboard message composer for a new or existing conversation. */
export function ConversationComposer(props: {
  error?: string;
  label: string;
  pending: boolean;
  submitLabel: string;
  onSubmit(message: string, idempotencyKey: string): Promise<void>;
}) {
  const [message, setMessage] = useState("");
  const id = useId();
  const idempotencyKey = useRef(crypto.randomUUID());

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = message.trim();
    if (!text || props.pending) return;
    try {
      await props.onSubmit(text, idempotencyKey.current);
      setMessage("");
      idempotencyKey.current = crypto.randomUUID();
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
      className="grid gap-2 rounded-lg border border-white/[0.09] bg-white/[0.035] p-3"
      onSubmit={submit}
    >
      <label className="sr-only" htmlFor={id}>
        {props.label}
      </label>
      <textarea
        className="min-h-20 w-full resize-y rounded-md border border-white/10 bg-black/25 px-3 py-2.5 font-mono text-sm leading-relaxed text-dashboard-text outline-none placeholder:text-dashboard-text-muted/65 focus:border-cyan-300/35 focus:ring-1 focus:ring-cyan-300/25 disabled:opacity-60"
        disabled={props.pending}
        id={id}
        maxLength={32_000}
        onChange={(event) => setMessage(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Message Junior…"
        value={message}
      />
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="min-w-0 font-mono text-xs leading-relaxed text-dashboard-text-muted">
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
