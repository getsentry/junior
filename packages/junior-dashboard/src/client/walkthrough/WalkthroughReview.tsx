import { useState } from "react";
import { Check, ChevronRight, Circle, PencilLine } from "lucide-react";
import type { WalkthroughDocument } from "@sentry/junior/api/schema";

import { CopyButton } from "../components/CopyButton";
import { DetailsPanel } from "../components/DetailsPanel";
import { StatusChip } from "../components/StatusChip";
import { Button } from "../components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible";
import { Textarea } from "../components/ui/textarea";
import { DetailsCard } from "../conversations/DetailsList";
import { DisplayText } from "../display-text/DisplayText";
import { cn, dashboardDisclosureChevronClass } from "../styles";
import {
  layerStatus,
  liveDecisions,
  reviewMarkdown,
  type AnswerMap,
  type ReviewDecision,
} from "./walkthroughModel";

type Layer = WalkthroughDocument["layers"][number];
type Verdict = "approve" | "changes" | "comment";

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
          <span className="text-xs text-dashboard-text-muted tabular-nums">
            {status.count} to answer
          </span>
        ) : null
      }
      title={props.stacked ? `#${layer.pr} ${layer.title}` : `#${layer.pr}`}
    >
      <div className="grid gap-3">
        {decisions.length ? (
          <ul className="-mx-1.5 m-0 grid list-none gap-0.5 p-0">
            {decisions.map((decision) => (
              <li key={decision.id}>
                <DecisionSummary
                  answer={answers[decision.id]}
                  decision={decision}
                  onOpen={() => props.onOpenStep(decision.stepKey)}
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
          placeholder="Leave a comment"
          rows={3}
          value={comment}
        />
        {markdown ? (
          <Collapsible className="grid gap-2">
            <div className="flex items-center justify-between gap-2">
              <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-xs font-medium text-dashboard-text-muted hover:text-dashboard-text">
                <ChevronRight
                  aria-hidden="true"
                  className={dashboardDisclosureChevronClass}
                />
                What GitHub gets
              </CollapsibleTrigger>
              <CopyButton
                getText={() => markdown}
                label="Copy as GitHub review"
              />
            </div>
            <CollapsibleContent>
              <div className="rounded-md border border-dashboard-border-subtle bg-dashboard-bg p-3 text-sm text-dashboard-text">
                <DisplayText text={markdown} />
              </div>
            </CollapsibleContent>
          </Collapsible>
        ) : null}
        <Button
          disabled={!verdict || Boolean(posted)}
          onClick={() => setPosted(verdict)}
          type="button"
          variant={verdict === "comment" ? "default" : "primary"}
        >
          {verdict === "changes"
            ? "Request changes as you"
            : verdict === "approve"
              ? "Approve as you"
              : verdict === "comment"
                ? "Comment as you"
                : `Answer ${status.kind === "open" ? status.count : ""} more to approve`}
        </Button>
      </div>
    </DetailsCard>
  );
}

function DecisionSummary(props: {
  answer: AnswerMap[string] | undefined;
  decision: ReviewDecision;
  onOpen(): void;
}) {
  const { answer, decision } = props;
  const Icon =
    answer?.value === "accept"
      ? Check
      : answer?.value === "change"
        ? PencilLine
        : Circle;
  return (
    <button
      className="grid w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 gap-y-0.5 rounded-md border-0 bg-transparent px-1.5 py-1.5 text-left text-xs leading-relaxed hover:bg-dashboard-surface-hover"
      onClick={props.onOpen}
      type="button"
    >
      <Icon
        aria-label={
          answer?.value === "accept"
            ? "Accepted"
            : answer?.value === "change"
              ? "Change requested"
              : "Not answered"
        }
        className={cn(
          "mt-0.5 size-3.5",
          answer?.value === "accept"
            ? "text-emerald-300"
            : answer?.value === "change"
              ? "text-amber-300"
              : "text-dashboard-text-faint",
        )}
      />
      <span
        className={cn(
          "line-clamp-2",
          answer ? "text-dashboard-text-muted" : "text-dashboard-text",
        )}
      >
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
        <span className="col-start-2 line-clamp-2 text-dashboard-text">
          <DisplayText inline text={answer.note} />
        </span>
      ) : null}
    </button>
  );
}
