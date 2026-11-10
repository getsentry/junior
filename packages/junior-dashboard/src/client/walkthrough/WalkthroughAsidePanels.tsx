import { useState } from "react";
import { CornerDownLeft } from "lucide-react";

import { CopyButton } from "../components/CopyButton";
import { ShimmerText } from "../components/ShimmerText";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { DisplayText } from "../display-text/DisplayText";
import { cn } from "../styles";
import {
  feedbackMarkdown,
  openFeedback,
  type AnswerMap,
  type ReviewDecision,
} from "./walkthroughModel";

/** A question pinned to the step where the reader asked it. */
export type WalkthroughAsk = {
  answer?: string;
  id: number;
  question: string;
  stepKey: string;
  stepLabel: string;
};

/**
 * Questions for this reader's private Conversation. Each answer keeps a link
 * back to the step, so the reader returns to the story in one click.
 */
export function WalkthroughAskPanel(props: {
  activeKey: string;
  asks: readonly WalkthroughAsk[];
  onAsk(question: string): void;
  onOpen(stepKey: string): void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <section aria-label="Questions" className="grid gap-3">
      <h3 className="m-0 text-xs font-medium text-dashboard-text-muted">
        Ask Junior
      </h3>
      <form
        className="relative"
        onSubmit={(event) => {
          event.preventDefault();
          if (!draft.trim()) return;
          props.onAsk(draft.trim());
          setDraft("");
        }}
      >
        <Input
          aria-label="Ask about this step"
          className="pr-9"
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Ask about this step"
          value={draft}
        />
        <CornerDownLeft
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-dashboard-text-faint"
        />
      </form>
      {props.asks.length ? (
        <ol className="m-0 grid list-none gap-3 p-0">
          {[...props.asks].reverse().map((ask) => (
            <li
              className={cn(
                "grid gap-1.5 rounded-md border px-3 py-2.5",
                ask.stepKey === props.activeKey
                  ? "border-dashboard-border-emphasis bg-dashboard-surface-raised"
                  : "border-dashboard-border-subtle bg-dashboard-fill-faint",
              )}
              key={ask.id}
            >
              <button
                className="w-fit cursor-pointer border-0 bg-transparent p-0 text-left text-xs text-dashboard-text-muted hover:text-dashboard-text"
                onClick={() => props.onOpen(ask.stepKey)}
                type="button"
              >
                On “{ask.stepLabel}”
              </button>
              <p className="m-0 text-sm font-medium text-dashboard-text">
                <DisplayText inline text={ask.question} />
              </p>
              {ask.answer ? (
                <p className="m-0 text-sm leading-relaxed text-dashboard-text-subtle">
                  {ask.answer}
                </p>
              ) : (
                <ShimmerText
                  active
                  className="text-sm text-dashboard-text-muted"
                >
                  Reading the diff
                </ShimmerText>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p className="m-0 text-xs text-dashboard-text-faint">
          Answers stay private to you and pin to the step you asked on.
        </p>
      )}
    </section>
  );
}

/** Feedback collected from "Change" answers, ready to post as a GitHub review. */
export function WalkthroughFeedbackPanel(props: {
  answers: AnswerMap;
  decisions: readonly ReviewDecision[];
}) {
  const feedback = openFeedback(props.decisions, props.answers);
  const [posted, setPosted] = useState(false);
  return (
    <section aria-label="Review" className="grid gap-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="m-0 text-xs font-medium text-dashboard-text-muted">
          Your review{feedback.length ? ` · ${feedback.length}` : ""}
        </h3>
        {feedback.length ? (
          <CopyButton
            getText={() => feedbackMarkdown(props.decisions, props.answers)}
            label="Copy as review"
          />
        ) : null}
      </div>
      {feedback.length ? (
        <>
          <ul className="m-0 grid list-none gap-2 p-0">
            {feedback.map(({ decision, note }) => (
              <li className="grid gap-0.5 text-sm" key={decision.id}>
                <span className="text-xs text-dashboard-text-muted">
                  {decision.prs.map((pr) => `#${pr}`).join(", ")}
                  {decision.location ? ` · ${decision.location}` : ""}
                </span>
                <span className="text-dashboard-text">
                  <DisplayText inline text={note ?? decision.question} />
                </span>
              </li>
            ))}
          </ul>
          <Button
            disabled={posted}
            onClick={() => setPosted(true)}
            type="button"
            variant="primary"
          >
            {posted ? "Posted as you (prototype)" : "Request changes as you"}
          </Button>
        </>
      ) : (
        <p className="m-0 text-xs text-dashboard-text-faint">
          “Change” answers collect here. Junior posts them with your GitHub
          account.
        </p>
      )}
    </section>
  );
}
