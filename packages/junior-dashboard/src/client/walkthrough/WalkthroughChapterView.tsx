import type {
  WalkthroughChapter,
  WalkthroughDocument,
} from "@sentry/junior/api/schema";

import { DisplayText } from "../display-text/DisplayText";
import { cn } from "../styles";
import {
  WalkthroughDecision,
  type DecisionAnswer,
} from "./WalkthroughDecision";
import { WalkthroughDiagram } from "./WalkthroughDiagram";
import {
  CitedProse,
  CodeReference,
  ProofCard,
  ReferenceList,
} from "./WalkthroughEvidence";
import {
  chapterTitle,
  citedEvidence,
  evidencePrs,
  type AnswerMap,
  type ReviewDecision,
} from "./walkthroughModel";

/**
 * Render the chapter the reader stands on. The heading names the chapter,
 * prose tells the story, decisions follow it, and code and checks follow as
 * evidence.
 */
export function WalkthroughChapterView(props: {
  answers: AnswerMap;
  chapter: WalkthroughChapter;
  decisions: readonly ReviewDecision[];
  document: WalkthroughDocument;
  index: number;
  onAnswer(answer: DecisionAnswer): void;
  total: number;
}) {
  const { chapter, document } = props;
  const stacked = document.layers.length > 1;
  // A lone PR needs no tag. In a stack, the tag says which layer this is.
  const prs = stacked ? evidencePrs(chapter.evidence) : [];
  const refs = citedEvidence(document, chapter.evidence);
  const scope = chapter.id;

  return (
    <article className="@container grid min-w-0 gap-6">
      <header className="grid gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-dashboard-text-muted">
          <span className="tabular-nums">
            {props.index + 1} of {props.total}
          </span>
          {prs.map((pr) => (
            <span className="font-mono" key={pr}>
              #{pr}
            </span>
          ))}
        </div>
        <h2 className="m-0 font-display text-3xl leading-tight font-medium text-dashboard-text">
          {chapterTitle(chapter)}
        </h2>
      </header>

      {/* Story first. A diagram sits beside it when the column is wide. */}
      <div
        className={cn(
          "grid gap-6",
          chapter.view &&
            "@3xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] @3xl:items-start",
        )}
      >
        <div className="grid max-w-2xl gap-3">
          <p className="m-0 text-lg leading-7 font-medium text-dashboard-text">
            <DisplayText inline text={chapter.caption} />
          </p>
          <CitedProse
            className="text-base leading-7 text-dashboard-text-subtle"
            refs={refs}
            scope={scope}
            text={chapter.body}
          />
          <ReferenceList
            conversationId={document.sourceConversationId}
            refs={refs}
            scope={scope}
          />
        </div>
        {chapter.view ? (
          <WalkthroughDiagram
            diagram={document.content.diagram}
            view={chapter.view}
          />
        ) : null}
      </div>

      {/* Decisions sit under the story, so they are seen before long code. */}
      {props.decisions.length ? (
        <section aria-label="Decisions" className="grid max-w-3xl gap-2">
          {props.decisions.map((decision) => (
            <WalkthroughDecision
              answer={props.answers[decision.id]}
              decision={decision}
              key={decision.id}
              onAnswer={props.onAnswer}
            />
          ))}
        </section>
      ) : null}

      {/* In the proof chapter the checks are the point, so they lead. */}
      {chapter.slot === "proof" ? (
        <ProofCard refs={refs} scope={scope} />
      ) : null}
      {refs.map((ref) =>
        ref.kind === "code" ? (
          <CodeReference
            key={ref.n}
            refItem={ref}
            scope={scope}
            stacked={stacked}
          />
        ) : null,
      )}
      {chapter.slot !== "proof" ? (
        <ProofCard refs={refs} scope={scope} />
      ) : null}
    </article>
  );
}
