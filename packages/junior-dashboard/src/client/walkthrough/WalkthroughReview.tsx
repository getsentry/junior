import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { WalkthroughDocument } from "@sentry/junior/api/schema";

import { CopyButton } from "../components/CopyButton";
import { DetailsPanel } from "../components/DetailsPanel";
import { StatusChip } from "../components/StatusChip";
import { Button } from "../components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { Textarea } from "../components/ui/textarea";
import { DetailsCard } from "../conversations/DetailsList";
import { DisplayText } from "../display-text/DisplayText";
import { cn } from "../styles";
import {
  layerStatus,
  liveDecisions,
  reviewMarkdown,
  type AnswerMap,
  type ReviewDecision,
} from "./walkthroughModel";

type Layer = WalkthroughDocument["layers"][number];
type Verdict = "approve" | "changes" | "comment";

const verdictActions: Record<Verdict, string> = {
  approve: "Approve as you",
  changes: "Request changes as you",
  comment: "Comment as you",
};

// Junior opens these PRs, so GitHub only counts a review from a person.
const verdictHelp: Record<Verdict, (pr: number) => string> = {
  approve: (pr) =>
    `Approves #${pr} on GitHub from your account. Junior opened this PR, so it can't approve it.`,
  changes: (pr) =>
    `Posts this review on #${pr} from your GitHub account and requests changes. Junior reads it and pushes a fix.`,
  comment: (pr) =>
    `Posts this review on #${pr} from your GitHub account. It doesn't approve or block the PR.`,
};

const verdictLabels: Record<Verdict, string> = {
  approve: "Approved",
  changes: "Changes requested",
  comment: "Commented",
};

/**
 * The reader's review, one GitHub review per pull request. Every decision
 * shows with its answer, so the reader sees what is done and what is open.
 */
export function WalkthroughReview(props: {
  answers: AnswerMap;
  decisions: readonly ReviewDecision[];
  document: WalkthroughDocument;
  onClose(): void;
  onOpenStep(stepKey: string): void;
  stepTitles: Readonly<Record<string, string>>;
}) {
  // Read the stack top down, like GitHub.
  const layers = [...props.document.layers].reverse();
  return (
    <DetailsPanel
      label="Review"
      onClose={props.onClose}
      sheetTitle="Review"
      title={
        <h2 className="m-0 font-sans text-sm font-semibold text-dashboard-text">
          Your review
        </h2>
      }
    >
      <div className="grid gap-3 p-3">
        {layers.map((layer) => (
          <LayerReview
            answers={props.answers}
            decisions={props.decisions}
            key={layer.pr}
            layer={layer}
            onOpenStep={props.onOpenStep}
            stacked={layers.length > 1}
            stepTitles={props.stepTitles}
          />
        ))}
      </div>
    </DetailsPanel>
  );
}

function LayerReview(props: {
  answers: AnswerMap;
  decisions: readonly ReviewDecision[];
  layer: Layer;
  onOpenStep(stepKey: string): void;
  stacked: boolean;
  stepTitles: Readonly<Record<string, string>>;
}) {
  const { answers, layer } = props;
  const [comment, setComment] = useState("");
  const [posted, setPosted] = useState<Verdict>();
  const decisions = liveDecisions(layer.pr, props.decisions);
  const status = layerStatus(layer.pr, props.decisions, answers);
  const markdown = reviewMarkdown({
    answers,
    comment,
    decisions: props.decisions,
    layer,
  });
  const verdict: Verdict | undefined =
    status.kind === "changes"
      ? "changes"
      : status.kind === "ready"
        ? "approve"
        : comment.trim()
          ? "comment"
          : undefined;

  return (
    <DetailsCard
      action={
        posted ? (
          <StatusChip size="compact" tone="success">
            {verdictLabels[posted]}
          </StatusChip>
        ) : status.kind === "open" ? (
          <span
            aria-label={`${status.count} not answered`}
            className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-dashboard-accent px-1 text-2xs font-semibold leading-none tabular-nums text-dashboard-text-inverse"
          >
            {status.count}
          </span>
        ) : null
      }
      title={props.stacked ? `#${layer.pr} ${layer.title}` : `#${layer.pr}`}
    >
      <div className="grid min-w-0 gap-3">
        {decisions.length ? (
          <ul className="-mx-1.5 m-0 grid list-none gap-0.5 p-0">
            {decisions.map((decision) => (
              <li key={decision.id}>
                <DecisionSummary
                  answer={answers[decision.id]}
                  decision={decision}
                  onOpen={() => props.onOpenStep(decision.stepKey)}
                  stepTitle={props.stepTitles[decision.stepKey]}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0">Nothing to decide here.</p>
        )}
        <Textarea
          aria-label={`Comment on #${layer.pr}`}
          onChange={(event) => setComment(event.target.value)}
          className="min-h-20"
          placeholder="Anything else for the author?"
          rows={3}
          value={comment}
        />
        {markdown ? (
          <div className="relative">
            <pre className="thin-scrollbar m-0 max-h-72 overflow-y-auto rounded-md border border-dashboard-border-subtle bg-dashboard-bg py-2.5 pr-10 pl-3 font-mono text-xs leading-relaxed wrap-anywhere whitespace-pre-wrap text-dashboard-text-subtle">
              {markdown}
            </pre>
            <div className="absolute top-1 right-1">
              <CopyButton
                getText={() => markdown}
                label="Copy review for GitHub"
              />
            </div>
          </div>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="grid">
                <Button
                  disabled={!verdict || Boolean(posted)}
                  onClick={() => setPosted(verdict)}
                  type="button"
                  variant={verdict === "comment" ? "default" : "primary"}
                >
                  {verdict
                    ? verdictActions[verdict]
                    : `Answer ${status.kind === "open" ? status.count : ""} more to approve`}
                </Button>
              </span>
            }
          />
          <TooltipContent>
            {verdict
              ? verdictHelp[verdict](layer.pr)
              : "Accept or change every decision first."}
          </TooltipContent>
        </Tooltip>
      </div>
    </DetailsCard>
  );
}

const answerLabels = {
  accept: "Accepted",
  change: "Change requested",
} as const;

/**
 * One decision and its answer. The row opens the step that asks it, so it
 * reads as a link, not a checkbox.
 */
function DecisionSummary(props: {
  answer: AnswerMap[string] | undefined;
  decision: ReviewDecision;
  onOpen(): void;
  stepTitle: string | undefined;
}) {
  const { answer, decision } = props;
  return (
    <button
      className="group grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 rounded-md border-0 bg-transparent px-1.5 py-1.5 text-left text-xs leading-relaxed hover:bg-dashboard-surface-hover"
      onClick={props.onOpen}
      type="button"
    >
      <span className="grid min-w-0 gap-0.5">
        <span className="line-clamp-2 text-dashboard-text">
          <DisplayText
            inline
            text={
              decision.context
                ? `${decision.context} ${decision.question}`
                : decision.question
            }
          />
        </span>
        {answer?.value === "change" && answer.note ? (
          <span className="line-clamp-2 text-dashboard-text-subtle">
            <DisplayText inline text={answer.note} />
          </span>
        ) : null}
        <span className="text-dashboard-text-muted">
          {props.stepTitle}
          {" · "}
          <span
            className={cn(
              answer?.value === "accept"
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
