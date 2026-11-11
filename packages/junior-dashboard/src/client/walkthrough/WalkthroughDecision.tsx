import { useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import type {
  WalkthroughAnswerResponse,
  WalkthroughUpdate,
} from "@sentry/junior/api/schema";

import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { DisplayText } from "../display-text/DisplayText";
import { cn } from "../styles";
import type { AnswerMap, ReviewDecision } from "./walkthroughModel";

/** What a reviewer saves for one decision. */
export type DecisionAnswer = Omit<
  WalkthroughAnswerResponse,
  "updatedAt" | "versionId"
>;

const accentClasses = {
  agree: "border-emerald-400/60 light:border-emerald-600/60",
  change: "border-amber-300/60 light:border-amber-600/60",
  open: "border-dashboard-accent",
  skip: "border-dashboard-border-emphasis",
} as const;

const answeredLabels = {
  agree: "Agreed",
  change: "Change requested",
  skip: "Skipped",
} as const;

/**
 * One claim the reviewer agrees with, asks to change, or skips. Once
 * answered it folds to one line. After an update, a reopened claim shows the
 * earlier answer, and a change request that the update answers asks whether
 * the change answers it.
 */
export function WalkthroughDecision(props: {
  answer: AnswerMap[string] | undefined;
  decision: ReviewDecision;
  /** The update item that answers the reviewer's change request. */
  feedback?: WalkthroughUpdate["items"][number];
  onAnswer(answer: DecisionAnswer): void;
  /** The answer before the code changed. */
  reopened?: AnswerMap[string];
}) {
  const { answer, decision, feedback, reopened } = props;
  const [draft, setDraft] = useState(answer?.note ?? "");
  const [editing, setEditing] = useState(false);
  // "Change" on a folded answer opens the actions again.
  const [expanded, setExpanded] = useState(false);
  const status = answer?.value ?? "open";
  const save = (value: DecisionAnswer["value"]) => {
    setEditing(false);
    setExpanded(false);
    props.onAnswer({ decisionId: decision.id, value });
  };

  if (answer && !expanded && !editing) {
    return (
      <Accent status={status}>
        <p className="m-0 flex min-w-0 items-baseline gap-1.5 text-sm text-dashboard-text-muted">
          <span className="inline-flex shrink-0 items-center gap-1 self-center font-medium text-dashboard-text-subtle">
            {answer.value === "agree" ? (
              <Check aria-hidden="true" className="size-3.5" />
            ) : null}
            {answeredLabels[answer.value]}
          </span>
          <span className="min-w-0 truncate">
            <DisplayText
              inline
              links={false}
              text={
                answer.value === "change" && answer.note
                  ? answer.note
                  : decision.claim
              }
            />
          </span>
          <span aria-hidden="true">·</span>
          <TextAction onClick={() => setExpanded(true)}>Change</TextAction>
        </p>
      </Accent>
    );
  }

  return (
    <Accent status={status}>
      <div className="grid gap-1.5">
        <p className="m-0 text-xs font-medium text-dashboard-text-faint">
          {feedback ? "Does this answer your feedback?" : "Do you agree?"}
        </p>
        <p className="m-0 text-sm text-dashboard-text">
          <DisplayText inline text={decision.claim} />
        </p>
        {decision.concern && !feedback ? (
          <p className="m-0 text-sm text-dashboard-text-muted">
            <DisplayText inline text={decision.concern} />
          </p>
        ) : null}
        {reopened && !answer ? (
          <p className="m-0 text-xs text-dashboard-text-muted">
            {reopenedText(reopened, Boolean(feedback))}
          </p>
        ) : null}
        {editing ? (
          <form
            className="grid gap-2 pt-1"
            onSubmit={(event) => {
              event.preventDefault();
              const note = draft.trim();
              props.onAnswer({
                decisionId: decision.id,
                value: "change",
                ...(note ? { note } : undefined),
              });
              setEditing(false);
              setExpanded(false);
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
        ) : (
          <p className="m-0 flex flex-wrap items-center gap-x-1.5 text-sm text-dashboard-text-faint">
            <TextAction
              current={answer?.value === "agree"}
              onClick={() => save("agree")}
            >
              {feedback ? "Yes" : "Agree"}
            </TextAction>
            <span aria-hidden="true">·</span>
            <TextAction
              current={answer?.value === "change"}
              onClick={() => {
                setDraft(answer?.note ?? reopened?.note ?? "");
                setEditing(true);
              }}
            >
              {feedback ? "Not yet" : "Request change"}
            </TextAction>
            <span aria-hidden="true">·</span>
            <TextAction
              current={answer?.value === "skip"}
              onClick={() => save("skip")}
            >
              Skip
            </TextAction>
          </p>
        )}
      </div>
    </Accent>
  );
}

/** The thin left rule. Its color is the answer. */
function Accent(props: {
  children: ReactNode;
  status: keyof typeof accentClasses;
}) {
  return (
    <div className={cn("border-l-2 py-0.5 pl-3", accentClasses[props.status])}>
      {props.children}
    </div>
  );
}

function TextAction(props: {
  children: ReactNode;
  current?: boolean;
  onClick(): void;
}) {
  return (
    <button
      aria-pressed={props.current}
      className={cn(
        "cursor-pointer rounded-sm border-0 bg-transparent p-0 text-sm hover:text-dashboard-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus",
        props.current
          ? "font-medium text-dashboard-text"
          : "text-dashboard-text-subtle",
      )}
      onClick={props.onClick}
      type="button"
    >
      {props.children}
    </button>
  );
}

function reopenedText(answer: AnswerMap[string], feedback: boolean): string {
  const asked = answer.note ? `asked: ${answer.note}` : "asked for a change";
  if (feedback) return `You ${asked}`;
  return answer.value === "agree"
    ? "Reopened: the code changed since you agreed."
    : `Reopened: the code changed since you ${asked}`;
}
