import { useState } from "react";
import { Check, PencilLine } from "lucide-react";
import type { WalkthroughAnswerResponse } from "@sentry/junior/api/schema";

import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { DisplayText } from "../display-text/DisplayText";
import { cn } from "../styles";
import type { AnswerMap, ReviewDecision } from "./walkthroughModel";

/** What a reviewer saves for one decision. */
export type DecisionAnswer = Omit<WalkthroughAnswerResponse, "updatedAt">;

/** One decision the reviewer answers with Agree, or Request change and a note. */
export function WalkthroughDecision(props: {
  answer: AnswerMap[string] | undefined;
  decision: ReviewDecision;
  onAnswer(answer: DecisionAnswer): void;
}) {
  const { answer, decision } = props;
  const [draft, setDraft] = useState(answer?.note ?? "");
  const [editing, setEditing] = useState(false);
  return (
    <div
      className={cn(
        "grid gap-3 rounded-md border px-3 py-3",
        answer?.value === "change"
          ? "border-amber-300/30 bg-amber-300/5"
          : answer?.value === "agree"
            ? "border-emerald-300/25 bg-emerald-300/5"
            : "border-dashboard-border-emphasis bg-dashboard-surface-raised",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="m-0 min-w-0 flex-1 text-sm text-dashboard-text">
          <DisplayText inline text={decision.question} />
        </p>
        <div className="flex shrink-0 gap-2">
          <Button
            aria-pressed={answer?.value === "agree"}
            onClick={() => {
              setEditing(false);
              props.onAnswer({ decisionId: decision.id, value: "agree" });
            }}
            type="button"
            variant={answer?.value === "agree" ? "primary" : "default"}
          >
            <Check aria-hidden="true" className="size-4" />
            Agree
          </Button>
          <Button
            aria-pressed={answer?.value === "change"}
            onClick={() => {
              setDraft(answer?.note ?? "");
              setEditing(true);
            }}
            type="button"
            variant={answer?.value === "change" ? "primary" : "default"}
          >
            <PencilLine aria-hidden="true" className="size-4" />
            Request change
          </Button>
        </div>
      </div>
      {answer?.value === "change" && answer.note && !editing ? (
        <p className="m-0 text-sm text-dashboard-text-subtle">
          You: <DisplayText inline text={answer.note} />
        </p>
      ) : null}
      {editing ? (
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const note = draft.trim();
            props.onAnswer({
              decisionId: decision.id,
              value: "change",
              ...(note ? { note } : undefined),
            });
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
