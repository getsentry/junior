import { useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { WalkthroughDocument } from "@sentry/junior/api/schema";

import { CopyButton } from "../components/CopyButton";
import { Textarea } from "../components/ui/textarea";
import { DetailsCard } from "../conversations/DetailsList";
import { DisplayText } from "../display-text/DisplayText";
import { cn } from "../styles";
import { CountBadge } from "./WalkthroughSidePanel";
import {
  openDecisionCount,
  reviewMarkdown,
  type AnswerMap,
  type ReviewDecision,
} from "./walkthroughModel";

type Layer = WalkthroughDocument["layers"][number];

/**
 * The reviewer's review: one GitHub review per pull request. Every decision
 * shows with its answer, so the reviewer sees what is done and what is open.
 */
export function WalkthroughReview(props: {
  /** The chapter the reviewer is on. Its decisions show highlighted. */
  activeChapter: number;
  answers: AnswerMap;
  chapterTitles: readonly string[];
  decisions: readonly ReviewDecision[];
  document: WalkthroughDocument;
  onOpenChapter(index: number): void;
}) {
  // Read the stack top down, like GitHub.
  const layers = [...props.document.layers].reverse();
  const ref = useRef<HTMLDivElement>(null);
  // Bring the current chapter's decisions into view, since a stack's review
  // is longer than the panel.
  useEffect(() => {
    ref.current
      ?.querySelector("[data-active-decision]")
      ?.scrollIntoView({ block: "nearest" });
  }, [props.activeChapter]);
  return (
    <div className="grid content-start gap-3 p-3" ref={ref}>
      {layers.map((layer) => (
        <LayerReview
          {...props}
          key={layer.pr}
          layer={layer}
          stacked={layers.length > 1}
          versionId={props.document.versionId}
        />
      ))}
    </div>
  );
}

function LayerReview(props: {
  activeChapter: number;
  answers: AnswerMap;
  chapterTitles: readonly string[];
  decisions: readonly ReviewDecision[];
  layer: Layer;
  onOpenChapter(index: number): void;
  stacked: boolean;
  versionId: string;
}) {
  const { answers, layer } = props;
  const [comment, setComment] = useCommentDraft(props.versionId, layer.pr);
  const decisions = props.decisions.filter((d) => d.prs.includes(layer.pr));
  const open = openDecisionCount(decisions, answers);
  const markdown = reviewMarkdown({
    answers,
    comment,
    decisions: props.decisions,
    pr: layer.pr,
  });

  return (
    <DetailsCard
      action={
        open ? <CountBadge count={open} label={`${open} to answer`} /> : null
      }
      title={props.stacked ? `#${layer.pr} ${layer.title}` : `#${layer.pr}`}
    >
      <div className="grid min-w-0 gap-3">
        {decisions.length ? (
          <ul className="-mx-1.5 m-0 grid list-none gap-0.5 p-0">
            {decisions.map((decision) => (
              <li key={decision.id}>
                <DecisionSummary
                  active={decision.chapterIndex === props.activeChapter}
                  answer={answers[decision.id]}
                  chapterTitle={props.chapterTitles[decision.chapterIndex]}
                  decision={decision}
                  onOpen={() => props.onOpenChapter(decision.chapterIndex)}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0">Nothing to decide here.</p>
        )}
        <Textarea
          aria-label={`Other comments on #${layer.pr}`}
          className="min-h-20"
          onChange={(event) => setComment(event.target.value)}
          placeholder="Other comments for the author"
          rows={3}
          value={comment}
        />
        <div className="grid gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <h4 className="m-0 font-sans text-xs font-medium text-dashboard-text-muted">
              Review text
            </h4>
            {markdown ? (
              <CopyButton getText={() => markdown} label="Copy review" />
            ) : null}
          </div>
          {markdown ? (
            <pre className="thin-scrollbar m-0 max-h-72 overflow-y-auto rounded-md border border-dashboard-border-subtle bg-dashboard-bg px-3 py-2.5 font-mono text-xs leading-relaxed wrap-anywhere whitespace-pre-wrap text-dashboard-text-subtle">
              {markdown}
            </pre>
          ) : (
            <p className="m-0">
              Answer a decision or add a comment, and the text to paste shows
              here.
            </p>
          )}
          {markdown ? (
            <p className="m-0">
              Paste it in the review on{" "}
              <a
                className="text-dashboard-text underline decoration-dashboard-border-heavy underline-offset-2 hover:decoration-dashboard-text"
                href={layer.url}
                rel="noreferrer"
                target="_blank"
              >
                #{layer.pr}
              </a>
              .
            </p>
          ) : null}
        </div>
      </div>
    </DetailsCard>
  );
}

const answerLabels = {
  agree: "Agreed",
  change: "Change requested",
} as const;

/**
 * One decision and its answer. The row opens the chapter that asks it, so it
 * reads as a link, not a checkbox.
 */
function DecisionSummary(props: {
  active: boolean;
  answer: AnswerMap[string] | undefined;
  chapterTitle: string | undefined;
  decision: ReviewDecision;
  onOpen(): void;
}) {
  const { answer } = props;
  return (
    <button
      aria-current={props.active ? "step" : undefined}
      className={cn(
        "group grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 rounded-md border-0 px-1.5 py-1.5 text-left text-xs leading-relaxed hover:bg-dashboard-surface-hover",
        props.active ? "bg-dashboard-fill-strong" : "bg-transparent",
      )}
      data-active-decision={props.active ? "" : undefined}
      onClick={props.onOpen}
      type="button"
    >
      <span className="grid min-w-0 gap-0.5">
        <span className="line-clamp-2 text-dashboard-text">
          <DisplayText inline text={props.decision.question} />
        </span>
        {answer?.note ? (
          <span className="line-clamp-2 text-dashboard-text-subtle">
            <DisplayText inline text={answer.note} />
          </span>
        ) : null}
        <span className="text-dashboard-text-muted">
          {props.chapterTitle}
          {" · "}
          <span
            className={cn(
              answer?.value === "agree"
                ? "text-emerald-300 light:text-emerald-700"
                : answer?.value === "change"
                  ? "text-amber-300 light:text-amber-700"
                  : "text-dashboard-text-muted",
            )}
          >
            {answer ? answerLabels[answer.value] : "Not answered"}
          </span>
        </span>
      </span>
      <ChevronRight
        aria-hidden="true"
        className="size-3.5 text-dashboard-text-faint group-hover:text-dashboard-text"
      />
    </button>
  );
}

const COMMENT_STORAGE_PREFIX = "junior:dashboard:walkthrough-comment:";

/**
 * The general comment stays in this browser. Only answers are saved on the
 * server; GitHub holds the review once it is pasted.
 */
function useCommentDraft(versionId: string, pr: number) {
  const key = `${COMMENT_STORAGE_PREFIX}${versionId}:${pr}`;
  const [comment, setComment] = useState(() => {
    try {
      return window.localStorage.getItem(key) ?? "";
    } catch {
      return "";
    }
  });
  function update(next: string) {
    setComment(next);
    try {
      if (next) window.localStorage.setItem(key, next);
      else window.localStorage.removeItem(key);
    } catch {
      // Storage can be full or blocked. The draft still lives in the page.
    }
  }
  return [comment, update] as const;
}
