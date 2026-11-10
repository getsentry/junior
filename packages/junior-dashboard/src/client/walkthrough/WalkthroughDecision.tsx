import { useState } from "react";
import { Check, PencilLine } from "lucide-react";

import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { DisplayText } from "../display-text/DisplayText";
import { cn } from "../styles";
import type { AnswerMap, ReviewDecision } from "./walkthroughModel";

/** One decision the reader answers with Accept, or Change and a note. */
export function WalkthroughDecisionRow(props: {
  answer: AnswerMap[string] | undefined;
  decision: ReviewDecision;
  onAnswer(decisionId: string, value: "accept" | "change", note?: string): void;
}) {
  const { answer, decision } = props;
  const [draft, setDraft] = useState(answer?.note ?? "");
  const [editing, setEditing] = useState(false);
  const closed = Boolean(decision.answeredBy);
  return (
    <div
      className={cn(
        "grid gap-3 rounded-md border px-3 py-3",
        answer?.value === "change"
          ? "border-amber-300/30 bg-amber-300/5"
          : answer?.value === "accept"
            ? "border-emerald-300/25 bg-emerald-300/5"
            : "border-dashboard-border-emphasis bg-dashboard-surface-raised",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="m-0 min-w-0 flex-1 text-sm text-dashboard-text">
          <DisplayText inline text={decision.question} />
        </p>
        {closed ? (
          <span className="text-xs text-dashboard-text-muted">
            Answered in the update
          </span>
        ) : (
          <div className="flex shrink-0 gap-2">
            <Button
              aria-pressed={answer?.value === "accept"}
              onClick={() => {
                setEditing(false);
                props.onAnswer(decision.id, "accept");
              }}
              type="button"
              variant={answer?.value === "accept" ? "primary" : "default"}
            >
              <Check aria-hidden="true" className="size-4" />
              Accept
            </Button>
            <Button
              aria-pressed={answer?.value === "change"}
              onClick={() => setEditing(true)}
              type="button"
              variant={answer?.value === "change" ? "primary" : "default"}
            >
              <PencilLine aria-hidden="true" className="size-4" />
              Change
            </Button>
          </div>
        )}
      </div>
      {answer?.value === "change" && answer.note && !editing ? (
        <p className="m-0 text-sm text-dashboard-text-subtle">
          You: {answer.note}
        </p>
      ) : null}
      {editing ? (
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            props.onAnswer(decision.id, "change", draft.trim() || undefined);
            setEditing(false);
          }}
        >
          <Textarea
            aria-label="What should change?"
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            placeholder="What should change?"
            rows={2}
            value={draft}
          />
          <div className="flex justify-end gap-2">
            <Button
              onClick={() => setEditing(false)}
              type="button"
              variant="quiet"
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary">
              Add to review
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
