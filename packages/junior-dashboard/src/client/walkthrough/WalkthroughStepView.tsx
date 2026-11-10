import { useState } from "react";
import {
  ArrowUpRight,
  Check,
  MessageSquareQuote,
  PencilLine,
} from "lucide-react";
import type {
  WalkthroughDocument,
  WalkthroughHunk,
} from "@sentry/junior/api/schema";

import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { DisplayText } from "../display-text/DisplayText";
import { cn } from "../styles";
import { WalkthroughDiagram } from "./WalkthroughDiagram";
import { WalkthroughEvidence } from "./WalkthroughEvidence";
import {
  confirmDecisionId,
  evidencePrs,
  slotLabels,
  typeLabels,
  type AnswerMap,
  type ReviewDecision,
  type WalkthroughStep,
} from "./walkthroughModel";

/** Render the step the reader stands on: caption first, code as evidence. */
export function WalkthroughStepView(props: {
  answers: AnswerMap;
  decisions: readonly ReviewDecision[];
  document: WalkthroughDocument;
  hunks: ReadonlyMap<string, WalkthroughHunk>;
  onAnswer(decisionId: string, value: "accept" | "change", note?: string): void;
  onAsk(question: string): void;
  onOpenStep(stepKey: string): void;
  step: WalkthroughStep;
}) {
  const { document, step } = props;
  const chapters = document.content.chapters;
  const touched =
    step.kind === "item"
      ? chapters.find((c) => c.id === step.item.touches)
      : undefined;
  const chapter = step.kind === "chapter" ? step.chapter : touched;
  const evidence =
    step.kind === "chapter" ? step.chapter.evidence : step.item.evidence;
  const prs = evidencePrs(evidence, props.hunks);
  const decisionIds =
    step.kind === "chapter"
      ? step.chapter.decisions.map((d) => d.id)
      : [
          ...(step.item.answers ? [confirmDecisionId(step.item.id)] : []),
          ...step.item.decisions.map((d) => d.id),
        ];
  const decisions = decisionIds
    .map((id) => props.decisions.find((d) => d.id === id))
    .filter((d): d is ReviewDecision => Boolean(d));
  const answeredFeedback =
    step.kind === "item" && step.item.answers
      ? props.answers[step.item.answers]
      : undefined;
  const changedBy =
    step.kind === "chapter"
      ? document.updates
          .flatMap((u) => u.items.map((item) => ({ item, update: u })))
          .filter(({ item }) => item.touches === step.chapter.id)
      : [];
  const view = step.kind === "chapter" ? step.chapter.view : undefined;
  const asks = step.kind === "chapter" ? step.chapter.asks : [];

  return (
    <article className="grid min-w-0 gap-5">
      <header className="grid gap-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-dashboard-text-muted">
          {chapter ? (
            <span>
              {typeLabels[chapter.type]} ·{" "}
              {slotLabels[chapter.slot] ?? chapter.slot}
            </span>
          ) : null}
          {prs.map((pr) => (
            <span
              className="rounded border border-dashboard-border-strong px-1.5 py-px font-mono"
              key={pr}
            >
              #{pr}
            </span>
          ))}
          {step.kind === "item" ? (
            <span className="text-dashboard-accent">New in this update</span>
          ) : null}
        </div>
        <h2 className="m-0 font-display text-2xl leading-snug font-medium text-dashboard-text text-balance">
          {step.kind === "chapter" ? step.chapter.caption : step.item.caption}
        </h2>
      </header>

      {step.kind === "item" && touched ? (
        <div className="grid gap-2 rounded-md border border-dashboard-border-subtle bg-dashboard-fill-faint p-3 text-sm">
          <button
            className="flex w-fit cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-left text-dashboard-text-muted hover:text-dashboard-text"
            onClick={() => props.onOpenStep(`chapter:${touched.id}`)}
            type="button"
          >
            Changes “{slotLabels[touched.slot]}”: {touched.caption}
            <ArrowUpRight aria-hidden="true" className="size-3.5" />
          </button>
          {answeredFeedback ? (
            <p className="m-0 flex items-start gap-2 text-dashboard-text">
              <MessageSquareQuote
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-dashboard-accent"
              />
              <span>
                Answers your feedback:{" "}
                {answeredFeedback.note ?? "Change requested."}
              </span>
            </p>
          ) : null}
        </div>
      ) : null}

      {changedBy.length ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashboard-accent/30 bg-dashboard-accent/5 px-3 py-2 text-sm text-dashboard-text">
          <span className="text-dashboard-accent">
            Changed since you reviewed it.
          </span>
          {changedBy.map(({ item }) => (
            <button
              className="cursor-pointer border-0 bg-transparent p-0 text-left text-dashboard-text-muted underline decoration-dashboard-border-heavy underline-offset-2 hover:text-dashboard-text"
              key={item.id}
              onClick={() => props.onOpenStep(`item:${item.id}`)}
              type="button"
            >
              {item.caption}
            </button>
          ))}
        </div>
      ) : null}

      {view ? (
        <WalkthroughDiagram diagram={document.content.diagram} view={view} />
      ) : null}

      {evidence.length ? (
        <section aria-label="Evidence" className="grid gap-3">
          {evidence.map((e, index) => (
            <WalkthroughEvidence
              document={document}
              evidence={e}
              hunks={props.hunks}
              key={index}
              tag={step.kind === "item" ? "new push" : undefined}
            />
          ))}
        </section>
      ) : null}

      {decisions.length ? (
        <section aria-label="Decisions" className="grid gap-2">
          {decisions.map((decision) => (
            <DecisionRow
              answer={props.answers[decision.id]}
              decision={decision}
              key={decision.id}
              onAnswer={props.onAnswer}
            />
          ))}
        </section>
      ) : null}

      {asks.length ? (
        <div className="flex flex-wrap gap-2">
          {asks.map((ask) => (
            <Button
              key={ask}
              onClick={() => props.onAsk(ask)}
              type="button"
              variant="quiet"
            >
              {ask}
            </Button>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function DecisionRow(props: {
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
