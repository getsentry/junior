import { useEffect, useRef, useState, type RefObject } from "react";
import type {
  WalkthroughChapter,
  WalkthroughDocument,
  WalkthroughUpdate,
} from "@sentry/junior/api/schema";

import { Drawer } from "../components/Drawer";
import { DisplayText } from "../display-text/DisplayText";
import { cn } from "../styles";
import {
  WalkthroughDecision,
  type DecisionAnswer,
} from "./WalkthroughDecision";
import { WalkthroughDiagram } from "./WalkthroughDiagram";
import { CitedProse, EvidencePanel } from "./WalkthroughEvidence";
import {
  chapterTitle,
  citedEvidence,
  type AnswerMap,
  type CitedEvidence,
  type ReviewDecision,
} from "./walkthroughModel";
import type { ChapterChange } from "./walkthroughUpdates";

/** Width at which evidence fits beside the prose. Matches `@3xl`. */
const SIDE_BY_SIDE_PX = 768;

/** The citation whose evidence is open, in the prose that cites it. */
type OpenEvidence = { scope: string; n: number };

/**
 * Render the chapter the reader stands on. The prose tells the story and
 * the decisions follow it. Evidence stays out of the way until a citation
 * opens it, beside the prose or in a drawer. After an update, what changed
 * comes first, and the earlier story stays below it.
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
  const articleRef = useRef<HTMLElement>(null);
  const wide = useWiderThan(articleRef, SIDE_BY_SIDE_PX);
  const [open, setOpen] = useState<OpenEvidence>();
  const stacked = document.layers.length > 1;
  const proseRefs = new Map<string, CitedEvidence[]>([
    [chapter.id, citedEvidence(document, chapter.evidence)],
    ...props.changes.map(
      (change) =>
        [
          changeScope(change),
          citedEvidence(document, change.item.evidence),
        ] as const,
    ),
  ]);
  const openRef = open
    ? proseRefs.get(open.scope)?.find((ref) => ref.n === open.n)
    : undefined;
  const diagram = chapter.view
    ? document.content.diagrams.find((d) => d.pr === chapter.view?.pr)
    : undefined;
  const prose = (scope: string, text: string, className: string) => (
    <CitedProse
      className={className}
      onOpen={(n) => setOpen({ scope, n })}
      openN={open?.scope === scope ? open.n : undefined}
      // A drawer is modal, so in a narrow column only a click opens it.
      // Otherwise tabbing through the prose would trap focus.
      openOnFocus={wide}
      refs={proseRefs.get(scope) ?? []}
      text={text}
    />
  );
  const decisionList = props.decisions.length ? (
    <section aria-label="Decisions" className="grid gap-3">
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
  // Open evidence takes the diagram's place, and the diagram returns when
  // the reader closes it.
  const side =
    openRef && wide ? (
      <EvidencePanel
        conversationId={document.sourceConversationId}
        onClose={() => setOpen(undefined)}
        refItem={openRef}
        stacked={stacked}
      />
    ) : diagram && chapter.view ? (
      <WalkthroughDiagram diagram={diagram} view={chapter.view} />
    ) : null;
  const changed = props.changes.length > 0;

  return (
    <article className="@container grid min-w-0 gap-6" ref={articleRef}>
      <header className="grid max-w-3xl gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-dashboard-text-muted">
          <span className="tabular-nums">
            {props.index + 1} of {props.total}
          </span>
          {props.added ? <ChangeBadge>New</ChangeBadge> : null}
          {props.changes.some((c) => c.unseen) ? (
            <ChangeBadge>Changed</ChangeBadge>
          ) : null}
        </div>
        <h2 className="m-0 font-display text-2xl leading-tight font-medium text-dashboard-text">
          <DisplayText inline text={chapterTitle(chapter)} />
        </h2>
        <p className="m-0 text-lg leading-7 text-dashboard-text-subtle">
          <DisplayText inline text={chapter.caption} />
        </p>
      </header>

      {/* Prose first. A diagram or open evidence sits beside it when the
          column is wide. Without either, the prose takes the reading width. */}
      <div
        className={cn(
          "grid gap-6",
          side &&
            "@3xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] @3xl:items-start",
        )}
      >
        <div className={cn("grid gap-5", side ? "max-w-2xl" : "max-w-3xl")}>
          {changed ? (
            <section aria-label="What changed" className="grid gap-5">
              {[...props.changes].reverse().map((change) => (
                <div
                  className="grid gap-2 border-l-2 border-amber-300/40 pl-4"
                  key={change.item.id}
                >
                  <p className="m-0 text-xs text-dashboard-text-muted">
                    Update {change.update}
                    {change.unseen ? " · new since you looked" : null}
                  </p>
                  <p className="m-0 text-lg leading-7 font-medium text-dashboard-text">
                    <DisplayText inline text={change.item.caption} />
                  </p>
                  {prose(
                    changeScope(change),
                    change.item.body,
                    "text-base leading-7 text-dashboard-text-subtle",
                  )}
                </div>
              ))}
              {decisionList}
              <h3 className="m-0 border-t border-dashboard-border-subtle pt-4 text-xs font-medium text-dashboard-text-faint">
                Earlier
              </h3>
            </section>
          ) : null}
          {prose(
            chapter.id,
            chapter.body,
            "text-base leading-7 text-dashboard-text-subtle",
          )}
          {/* After an update, decisions follow what changed, since that is
              what the reviewer judges again. */}
          {changed ? null : decisionList}
        </div>
        {side ? (
          <div className="min-w-0 @3xl:sticky @3xl:top-6">{side}</div>
        ) : null}
      </div>

      {openRef && !wide ? (
        <Drawer
          closeLabel="Close evidence"
          header={
            <span className="text-sm font-medium text-dashboard-text">
              Evidence {openRef.n}
            </span>
          }
          label={`Evidence ${openRef.n}`}
          onClose={() => setOpen(undefined)}
          openKey={`${open?.scope}:${openRef.n}`}
        >
          <EvidencePanel
            conversationId={document.sourceConversationId}
            refItem={openRef}
            stacked={stacked}
          />
        </Drawer>
      ) : null}
    </article>
  );
}

function changeScope(change: ChapterChange): string {
  return `${change.item.touches}:${change.item.id}`;
}

/** Track whether an element is at least `px` wide. */
function useWiderThan(ref: RefObject<HTMLElement | null>, px: number) {
  const [wider, setWider] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWider(entry.contentRect.width >= px);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, px]);
  return wider;
}

function ChangeBadge(props: { children: string }) {
  return (
    <span className="rounded-sm bg-amber-300/10 px-1.5 py-0.5 font-medium text-amber-200">
      {props.children}
    </span>
  );
}
