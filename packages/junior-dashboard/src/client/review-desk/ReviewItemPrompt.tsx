import { Inbox } from "lucide-react";
import type { ReviewItemPayload } from "@sentry/junior/api/schema";

import { Button } from "../components/ui/button";

/**
 * Show in place of the message box while Junior waits for the viewer to
 * answer a Review item. The reader can go to the question, or write a
 * message instead.
 */
export function ReviewItemPrompt(props: {
  item: ReviewItemPayload;
  onShowQuestion: () => void;
  onWriteMessage: () => void;
}) {
  return (
    <section
      aria-label="Junior is waiting for your answer"
      className="flex flex-wrap items-center gap-3 rounded-xl border border-dashboard-accent/30 bg-dashboard-surface-panel px-4 py-3 font-sans text-sm text-dashboard-text"
    >
      <span
        aria-hidden="true"
        className="grid size-9 shrink-0 place-items-center rounded-lg border border-dashboard-accent/30 bg-dashboard-accent/10 text-dashboard-accent"
      >
        <Inbox size={18} />
      </span>
      <div className="grid min-w-48 flex-1 gap-0.5">
        <p className="m-0 font-medium">Junior is waiting for your answer</p>
        <p className="m-0 truncate text-xs text-dashboard-text-muted">
          {props.item.title}
        </p>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <Button onClick={props.onWriteMessage} variant="quiet">
          Write a message
        </Button>
        <Button onClick={props.onShowQuestion}>Show question</Button>
      </div>
    </section>
  );
}
