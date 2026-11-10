import { useEffect, useRef } from "react";

import { getDashboardAgentName } from "../agentName";
import { useDashboardCoreData } from "../api";
import { ClampedPreview } from "../components/ClampedPreview";
import { DetailsPanel } from "../components/DetailsPanel";
import { ShimmerText } from "../components/ShimmerText";
import { Button } from "../components/ui/button";
import { ConversationComposer } from "../conversations/ConversationComposer";
import { TranscriptMessageShell } from "../conversations/TranscriptMessageShell";
import { DisplayText } from "../display-text/DisplayText";

/** A question pinned to the step where the reader asked it. */
export type WalkthroughQuestion = {
  answer?: string;
  id: string;
  /** Text the reader selected, when the question is about a passage. */
  quote?: string;
  stepKey: string;
  stepTitle: string;
  text: string;
};

/**
 * The reader's questions, laid out like a Quick question. Each question shows
 * the step it is about, so one click returns to the story.
 */
export function WalkthroughQuestions(props: {
  /** Quote or step the next question is about. */
  anchor: { quote?: string; stepKey: string; stepTitle: string };
  onClose(): void;
  onOpenStep(stepKey: string): void;
  onSubmit(text: string): Promise<void>;
  questions: readonly WalkthroughQuestion[];
  /** Questions Junior suggests for the current step. */
  suggestions: readonly string[];
  walkthroughId: string;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const me = useDashboardCoreData().data?.me.user;
  const viewerName = me?.name?.trim() || me?.email || "You";
  const agentName = getDashboardAgentName();
  const thinking = props.questions.some((q) => q.answer === undefined);
  const asked = new Set(props.questions.map((q) => q.text));
  const suggestions = props.suggestions.filter((s) => !asked.has(s));

  // Keep the newest message in view.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [props.questions]);

  return (
    <DetailsPanel
      label="Questions"
      onClose={props.onClose}
      sheetTitle="Questions"
      title={
        <h2 className="m-0 font-sans text-sm font-semibold text-dashboard-text">
          Questions
        </h2>
      }
    >
      <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto]">
        <div
          className="grid content-start grid-cols-[minmax(0,1fr)] gap-5 overflow-y-auto px-4 py-4"
          ref={scrollerRef}
        >
          {props.questions.map((question) => (
            <div className="grid gap-3" key={question.id}>
              <button
                className="m-0 cursor-pointer border-0 border-l-2 border-dashboard-accent bg-transparent py-0 pr-0 pl-2.5 text-left text-sm text-dashboard-text-muted hover:text-dashboard-text"
                onClick={() => props.onOpenStep(question.stepKey)}
                type="button"
              >
                <ClampedPreview
                  className="leading-relaxed break-words whitespace-pre-wrap"
                  label="quote"
                  lines={3}
                >
                  {question.quote ?? question.stepTitle}
                </ClampedPreview>
              </button>
              <TranscriptMessageShell
                actor={viewerName}
                avatarUrl={me?.avatarUrl}
                role="user"
              >
                <span className="text-sm font-semibold text-dashboard-text">
                  {viewerName}
                </span>
                <DisplayText chat text={question.text} />
              </TranscriptMessageShell>
              <TranscriptMessageShell actor={agentName} role="assistant">
                <span className="text-sm font-semibold text-dashboard-accent-text">
                  {agentName}
                </span>
                {question.answer === undefined ? (
                  <ShimmerText
                    active
                    className="text-sm text-dashboard-text-muted"
                  >
                    Thinking…
                  </ShimmerText>
                ) : (
                  <DisplayText chat text={question.answer} />
                )}
              </TranscriptMessageShell>
            </div>
          ))}
        </div>
        <div className="grid gap-2 px-3 pt-2 pb-2">
          <blockquote className="m-0 border-l-2 border-dashboard-border-heavy pl-2.5 text-xs text-dashboard-text-muted">
            <ClampedPreview
              className="leading-relaxed break-words whitespace-pre-wrap"
              key={props.anchor.quote ?? props.anchor.stepKey}
              label="quote"
              lines={2}
            >
              {props.anchor.quote ?? `About “${props.anchor.stepTitle}”`}
            </ClampedPreview>
          </blockquote>
          {suggestions.length && !thinking ? (
            <div className="flex flex-wrap gap-2">
              {suggestions.map((suggestion) => (
                <Button
                  className="h-7 rounded-full px-2.5 text-xs"
                  key={suggestion}
                  onClick={() => void props.onSubmit(suggestion)}
                >
                  {suggestion}
                </Button>
              ))}
            </div>
          ) : null}
          <ConversationComposer
            compact
            disabled={thinking}
            draftId={`walkthrough:${props.walkthroughId}`}
            holdDraftUntilAccept
            label="Question"
            onSubmit={(text) => props.onSubmit(text)}
            placeholder={
              props.questions.length ? "Ask a follow-up…" : "Ask a question…"
            }
            submitLabel="Ask"
          />
          <p className="m-0 pl-1 text-xs text-dashboard-text-muted">
            Only you see these. Junior can read the code but not change it.
          </p>
        </div>
      </div>
    </DetailsPanel>
  );
}
