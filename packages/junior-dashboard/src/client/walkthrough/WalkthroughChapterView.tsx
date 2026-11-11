import type {
  WalkthroughChapter,
  WalkthroughDocument,
  WalkthroughUpdate,
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
  chapterSlotLabel,
  chapterTitle,
  citedEvidence,
  evidencePrs,
  type AnswerMap,
  type ReviewDecision,
} from "./walkthroughModel";
import type { ChapterChange } from "./walkthroughUpdates";

/**
 * Render the chapter the reader stands on. The heading names the chapter,
 * prose tells the story, decisions follow it, and code and checks follow as
 * evidence. After an update, what changed comes first, and the earlier story
 * stays below it.
 */
export function WalkthroughChapterView(props: {
  /** Added by an update the reviewer has not seen. */
  added?: boolean;
  answers: AnswerMap;
  chapter: WalkthroughChapter;
  changes: readonly ChapterChange[];
  decisions: readonly ReviewDecision[];
  document: WalkthroughDocument;
  feedback: Readonly<Record<string, WalkthroughUpdate["items"][number]>>;
  index: number;
  onAnswer(answer: DecisionAnswer): void;
  reopened: AnswerMap;
  total: number;
}) {
  const { chapter, document } = props;
  const stacked = document.layers.length > 1;
  // A lone PR needs no tag. In a stack, the tag says which layer this is.
  const prs = stacked ? evidencePrs(chapter.evidence) : [];
  const refs = citedEvidence(document, chapter.evidence);
  const scope = chapter.id;
  const diagram = chapter.view
    ? document.content.diagrams.find((d) => d.pr === chapter.view?.pr)
    : undefined;
  // After an update, decisions follow what changed, since that is what the
  // reviewer judges again.
  const changed = props.changes.length > 0;
  const decisionList = props.decisions.length ? (
    <section aria-label="Decisions" className="grid max-w-3xl gap-2">
      {props.decisions.map((decision) => (
        <WalkthroughDecision
          answer={props.answers[decision.id]}
          decision={decision}
          feedback={props.feedback[decision.id]}
          key={decision.id}
          onAnswer={props.onAnswer}
          reopened={props.reopened[decision.id]}
        />
      ))}
    </section>
  ) : null;

  return (
    <article className="@container grid min-w-0 gap-6">
      <header className="grid gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-dashboard-text-muted">
          <span className="tabular-nums">
            {props.index + 1} of {props.total}
          </span>
          <span className="font-medium text-dashboard-text-subtle">
            {chapterSlotLabel(chapter)}
          </span>
          {prs.map((pr) => (
            <span className="font-mono" key={pr}>
              #{pr}
            </span>
          ))}
          {props.added ? <ChangeBadge>New</ChangeBadge> : null}
          {props.changes.some((c) => c.unseen) ? (
            <ChangeBadge>Changed</ChangeBadge>
          ) : null}
        </div>
        <h2 className="m-0 max-w-3xl font-display text-2xl leading-tight font-medium text-dashboard-text">
          <DisplayText inline text={chapterTitle(chapter)} />
        </h2>
      </header>

      {props.changes.length ? (
        <section aria-label="What changed" className="grid max-w-2xl gap-5">
          {[...props.changes].reverse().map((change) => (
            <ChangeItem
              change={change}
              document={document}
              key={change.item.id}
              stacked={stacked}
            />
          ))}
          {decisionList}
          <h3 className="m-0 border-t border-dashboard-border-subtle pt-4 text-xs font-medium text-dashboard-text-faint">
            Earlier
          </h3>
        </section>
      ) : null}

      {/* Story first. A diagram sits beside it when the column is wide. */}
      <div
        className={cn(
          "grid gap-6",
          diagram &&
            "@3xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] @3xl:items-start",
        )}
      >
        <div className="grid max-w-2xl gap-3">
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
        {diagram && chapter.view ? (
          <WalkthroughDiagram diagram={diagram} view={chapter.view} />
        ) : null}
      </div>

      {/* Decisions sit under the story, so they are seen before long code. */}
      {changed ? null : decisionList}

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

function ChangeBadge(props: { children: string }) {
  return (
    <span className="rounded-sm bg-amber-300/10 px-1.5 py-0.5 font-medium text-amber-200">
      {props.children}
    </span>
  );
}

/** One update item: what changed in this chapter and why, with its code. */
function ChangeItem(props: {
  change: ChapterChange;
  document: WalkthroughDocument;
  stacked: boolean;
}) {
  const { change, document } = props;
  const refs = citedEvidence(document, change.item.evidence);
  const scope = `${change.item.touches}:${change.item.id}`;
  return (
    <div className="grid gap-3 border-l-2 border-amber-300/40 pl-4">
      <p className="m-0 text-xs text-dashboard-text-muted">
        Update {change.update}
        {change.unseen ? " · new since you looked" : null}
      </p>
      <p className="m-0 text-lg leading-7 font-medium text-dashboard-text">
        <DisplayText inline text={change.item.caption} />
      </p>
      <CitedProse
        className="text-base leading-7 text-dashboard-text-subtle"
        refs={refs}
        scope={scope}
        text={change.item.body}
      />
      <ReferenceList
        conversationId={document.sourceConversationId}
        refs={refs}
        scope={scope}
      />
      {refs.map((ref) =>
        ref.kind === "code" ? (
          <CodeReference
            key={ref.n}
            refItem={ref}
            scope={scope}
            stacked={props.stacked}
          />
        ) : null,
      )}
    </div>
  );
}
