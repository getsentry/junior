import { useState, type ReactNode } from "react";
import { Check, MessageCircleQuestion } from "lucide-react";
import type {
  WalkthroughAnswerResponse,
  WalkthroughUpdate,
} from "@sentry/junior/api/schema";

import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { DisplayText } from "../display-text/DisplayText";
import { cn } from "../styles";
import type {
  AnswerMap,
  ClaimQuestion,
  ReviewDecision,
} from "./walkthroughModel";

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
 * answered it folds to its status and the claim. After an update, a reopened claim shows the
 * earlier answer, and a change request that the update answers asks whether
 * the change answers it.
 */
export function WalkthroughDecision(props: {
  answer: AnswerMap[string] | undefined;
  /** The reviewer's question about this claim, once they asked one. */
  asked?: ClaimQuestion;
  decision: ReviewDecision;
  /** The update item that answers the reviewer's change request. */
  feedback?: WalkthroughUpdate["items"][number];
  onAnswer(answer: DecisionAnswer): void;
  /** Start a question about this claim beside the story. */
  onAsk(): void;
  /** Show the reviewer's question about this claim and its answer. */
  onShowQuestion(): void;
  /** The answer before the code changed. */
  reopened?: AnswerMap[string];
}) {
  const { answer, asked, decision, feedback, reopened } = props;
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

  const heading = feedback ? "Does this answer your feedback?" : "Claim";

  // Two sizes only: small for labels, status, and actions; the chapter's body
  // size for the claim and its concern, so the card reads as part of the story.
  if (answer && !expanded && !editing) {
    return (
      <Accent status={status}>
        <div className="grid gap-1">
          <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-dashboard-text-muted">
            <span className="font-medium">{heading}</span>
            <span aria-hidden="true">·</span>
            <span className="inline-flex items-center gap-1 font-medium text-dashboard-text">
              {answer.value === "agree" ? (
                <Check aria-hidden="true" className="size-3.5" />
              ) : null}
              {answeredLabels[answer.value]}
            </span>
            <span aria-hidden="true">·</span>
            <TextAction onClick={() => setExpanded(true)}>
              Change answer
            </TextAction>
          </p>
          <p className="m-0 text-base leading-7 text-dashboard-text-subtle">
            <DisplayText inline links={false} text={decision.claim} />
          </p>
          {answer.value === "change" && answer.note ? (
            <p className="m-0 text-sm text-dashboard-text-muted">
              Your note: <DisplayText inline links={false} text={answer.note} />
            </p>
          ) : null}
          {asked ? (
            <AskedLine asked={asked} onShow={props.onShowQuestion} />
          ) : null}
        </div>
      </Accent>
    );
  }

  return (
    <Accent status={status}>
      <div className="grid gap-3">
        <div className="grid gap-1">
          <p className="m-0 text-sm font-medium text-dashboard-text-muted">
            {heading}
          </p>
          <p className="m-0 text-base leading-7 font-medium text-dashboard-text">
            <DisplayText inline text={decision.claim} />
          </p>
          {decision.concern && !feedback ? (
            <p className="m-0 text-base leading-7 text-dashboard-text-subtle">
              <span className="text-dashboard-text-muted">
                Why it's worth checking:
              </span>{" "}
              <DisplayText inline text={decision.concern} />
            </p>
          ) : null}
          {reopened && !answer ? (
            <p className="m-0 text-sm text-dashboard-text-muted">
              {reopenedText(reopened, Boolean(feedback))}
            </p>
          ) : null}
        </div>
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
          <div className="flex flex-wrap items-center gap-2">
            <AnswerButton
              current={answer?.value === "agree"}
              onClick={() => save("agree")}
            >
              {feedback ? "Yes" : "Agree"}
            </AnswerButton>
            <AnswerButton
              current={answer?.value === "change"}
              onClick={() => {
                setDraft(answer?.note ?? reopened?.note ?? "");
                setEditing(true);
              }}
            >
              {feedback ? "Not yet" : "Request change"}
            </AnswerButton>
            <AnswerButton
              current={answer?.value === "skip"}
              onClick={() => save("skip")}
            >
              Skip
            </AnswerButton>
            {asked ? null : (
              <Button
                className="h-8 px-3 text-sm"
                onClick={props.onAsk}
                type="button"
                variant="quiet"
              >
                <MessageCircleQuestion aria-hidden="true" className="size-4" />
                Ask about this
              </Button>
            )}
          </div>
        )}
        {asked ? (
          <AskedLine asked={asked} onShow={props.onShowQuestion} />
        ) : null}
      </div>
    </Accent>
  );
}

/** The reviewer's question about the claim, and whether it has an answer. */
function AskedLine(props: { asked: ClaimQuestion; onShow(): void }) {
  return (
    <p className="m-0 flex flex-wrap items-center gap-x-1.5 text-sm text-dashboard-text-muted">
      <MessageCircleQuestion aria-hidden="true" className="size-4 shrink-0" />
      {props.asked.answered
        ? "You asked about this claim. It has an answer."
        : "You asked about this claim. The answer is on its way."}
      <button
        className="cursor-pointer rounded-sm border-0 bg-transparent p-0 text-sm text-dashboard-text underline underline-offset-4 hover:text-dashboard-text-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus"
        onClick={props.onShow}
        type="button"
      >
        {props.asked.answered ? "Read the answer" : "See the question"}
      </button>
    </p>
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

/** One answer to a claim. The chosen one stays pressed. */
function AnswerButton(props: {
  children: ReactNode;
  current?: boolean;
  onClick(): void;
}) {
  return (
    <Button
      aria-pressed={props.current}
      className={cn(
        "h-8 px-3 text-sm",
        props.current &&
          "border-dashboard-text-muted bg-dashboard-fill-strong font-medium text-dashboard-text",
      )}
      onClick={props.onClick}
      type="button"
    >
      {props.current ? <Check aria-hidden="true" className="size-4" /> : null}
      {props.children}
    </Button>
  );
}

function TextAction(props: { children: ReactNode; onClick(): void }) {
  return (
    <button
      className="cursor-pointer rounded-sm border-0 bg-transparent p-0 text-sm text-dashboard-text-subtle hover:text-dashboard-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus"
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
