import { ArrowUpRight, MessageCircleQuestion } from "lucide-react";
import type {
  WalkthroughDocument,
  WalkthroughHunk,
} from "@sentry/junior/api/schema";

import { StatusChip } from "../components/StatusChip";
import { Button } from "../components/ui/button";
import { DisplayText } from "../display-text/DisplayText";
import { WalkthroughDecisionRow } from "./WalkthroughDecision";
import { WalkthroughDiagram } from "./WalkthroughDiagram";
import { WalkthroughEvidence } from "./WalkthroughEvidence";
import {
  confirmDecisionId,
  evidencePrs,
  slotLabels,
  stepChapter,
  stepTitle,
  type AnswerMap,
  type ReviewDecision,
  type WalkthroughStep,
} from "./walkthroughModel";

type RootCause = NonNullable<WalkthroughDocument["content"]["rootCause"]>;

const rootCauseLabels: Record<RootCause, string> = {
  likely: "Root cause likely, not proven",
  not_proven: "Root cause not proven",
  proven: "Root cause proven",
};

const rootCauseTones = {
  likely: "warning",
  not_proven: "danger",
  proven: "success",
} as const satisfies Record<RootCause, string>;

/**
 * Render the step the reader stands on. The heading names the step, prose
 * tells the story, and code and data follow as evidence.
 */
export function WalkthroughStepView(props: {
  answers: AnswerMap;
  decisions: readonly ReviewDecision[];
  document: WalkthroughDocument;
  hunks: ReadonlyMap<string, WalkthroughHunk>;
  index: number;
  onAnswer(decisionId: string, value: "accept" | "change", note?: string): void;
  onAsk(question?: string): void;
  onOpenStep(stepKey: string): void;
  step: WalkthroughStep;
  total: number;
}) {
  const { document, step } = props;
  const chapter = stepChapter(document, step);
  const evidence =
    step.kind === "chapter" ? step.chapter.evidence : step.item.evidence;
  // A lone PR needs no tag. In a stack, the tag says which layer this is.
  const prs =
    document.layers.length > 1 ? evidencePrs(evidence, props.hunks) : [];
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
      ? document.updates.flatMap((u) =>
          u.items.filter((item) => item.touches === step.chapter.id),
        )
      : [];
  const view = step.kind === "chapter" ? step.chapter.view : undefined;
  const asks = step.kind === "chapter" ? step.chapter.asks : [];
  const caption =
    step.kind === "chapter" ? step.chapter.caption : step.item.caption;
  const body = step.kind === "chapter" ? step.chapter.body : step.item.body;

  return (
    <article className="grid min-w-0 gap-6">
      <header className="grid gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-dashboard-text-muted">
          <span className="tabular-nums">
            {props.index + 1} of {props.total}
          </span>
          {step.kind === "item" ? (
            <span className="text-dashboard-accent-text">
              Update {document.updates.indexOf(step.update) + 1}
            </span>
          ) : null}
          {prs.map((pr) => (
            <span className="font-mono" key={pr}>
              #{pr}
            </span>
          ))}
          {chapter?.slot === "cause" && document.content.rootCause ? (
            <StatusChip
              size="compact"
              tone={rootCauseTones[document.content.rootCause]}
            >
              {rootCauseLabels[document.content.rootCause]}
            </StatusChip>
          ) : null}
        </div>
        <h2 className="m-0 font-display text-3xl leading-tight font-medium text-dashboard-text">
          {stepTitle(document, step)}
        </h2>
        {/* The Quick question menu reads selections inside this marker. */}
        <div
          className="grid max-w-2xl gap-2"
          data-quick-question-message-id={step.key}
        >
          <p className="m-0 text-lg leading-7 font-medium text-dashboard-text">
            <DisplayText inline text={caption} />
          </p>
          <div className="text-base leading-7 text-dashboard-text-subtle">
            <DisplayText text={body} />
          </div>
        </div>
      </header>

      {step.kind === "item" && chapter ? (
        <div className="grid gap-2 rounded-md border border-dashboard-border-subtle bg-dashboard-fill-faint p-3 text-sm">
          <button
            className="flex w-fit cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-left text-dashboard-text-muted hover:text-dashboard-text"
            onClick={() => props.onOpenStep(`chapter:${chapter.id}`)}
            type="button"
          >
            You reviewed “{slotLabels[chapter.slot]}” before this update
            <ArrowUpRight aria-hidden="true" className="size-3.5" />
          </button>
          {answeredFeedback ? (
            <p className="m-0 text-dashboard-text">
              Your feedback: {answeredFeedback.note ?? "Change requested."}
            </p>
          ) : null}
        </div>
      ) : null}

      {changedBy.length ? (
        <div className="grid gap-1 rounded-md border border-dashboard-accent/30 bg-dashboard-accent/5 px-3 py-2 text-sm">
          <span className="text-dashboard-accent-text">
            Changed after you reviewed it
          </span>
          {changedBy.map((item) => (
            <button
              className="w-fit cursor-pointer border-0 bg-transparent p-0 text-left text-dashboard-text-muted underline decoration-dashboard-border-heavy underline-offset-2 hover:text-dashboard-text"
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
            />
          ))}
        </section>
      ) : null}

      {decisions.length ? (
        <section aria-label="Decisions" className="grid gap-2">
          {decisions.map((decision) => (
            <WalkthroughDecisionRow
              answer={props.answers[decision.id]}
              decision={decision}
              key={decision.id}
              onAnswer={props.onAnswer}
            />
          ))}
        </section>
      ) : null}

      <section
        aria-label="Ask about this step"
        className="flex flex-wrap items-center gap-2"
      >
        <Button
          className="h-7 rounded-full px-2.5 text-xs"
          onClick={() => props.onAsk()}
          type="button"
        >
          <MessageCircleQuestion aria-hidden="true" size={13} />
          Ask about this
        </Button>
        {asks.map((ask) => (
          <Button
            className="h-7 rounded-full px-2.5 text-xs"
            key={ask}
            onClick={() => props.onAsk(ask)}
            type="button"
            variant="quiet"
          >
            {ask}
          </Button>
        ))}
      </section>
    </article>
  );
}
