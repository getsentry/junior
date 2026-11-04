import { useContext, useEffect, useRef } from "react";
import { ArrowDown, Sparkles } from "lucide-react";

import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { InlineError } from "../components/InlineError";
import { DisplayText } from "../display-text/DisplayText";
import { useConversationCatchUpState } from "./conversationCatchUpState";
import { TranscriptJumpToLatestContext } from "./transcriptBottomPinning";

const cardClass =
  "grid gap-2.5 rounded-lg border border-dashboard-accent/20 bg-dashboard-accent/10 px-3.5 py-3 font-sans text-sm leading-relaxed text-dashboard-text";

/** Offer the catch-up inside the "New" marker, so it takes no extra row. */
export function ConversationCatchUpButton() {
  const state = useConversationCatchUpState();
  if (!state || state.data || state.pending) return null;
  return (
    <>
      <button
        className="inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-full border border-dashboard-accent/30 bg-transparent px-2.5 font-sans text-xs font-medium text-dashboard-accent-text transition-colors hover:border-dashboard-accent/60 hover:bg-dashboard-accent/10 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-dashboard-focus/55"
        onClick={state.request}
        type="button"
      >
        <Sparkles aria-hidden="true" size={12} strokeWidth={2} />
        Catch me up
      </button>
      {state.error ? (
        <InlineError className="shrink-0 text-xs">
          Failed. Try again.
        </InlineError>
      ) : null}
    </>
  );
}

/** Show the loading or loaded catch-up under the "New" marker. */
export function ConversationCatchUpCard() {
  const state = useConversationCatchUpState();
  const jumpToLatest = useContext(TranscriptJumpToLatestContext);
  const cardRef = useRef<HTMLDivElement>(null);
  const shown = state?.data ? "data" : state?.pending ? "pending" : undefined;
  // The transcript holds the row below the reader's place, so the card grows
  // up, out of view. Bring it back after that scroll fix runs.
  useEffect(() => {
    if (!shown) return;
    const frame = requestAnimationFrame(() => {
      // Keep the "New" marker above the card in view too.
      const marker = cardRef.current?.closest(
        "[data-transcript-unread-marker]",
      );
      marker?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [shown]);

  if (state?.data) {
    return (
      <div
        aria-label="Catch-up"
        className={cardClass}
        ref={cardRef}
        role="group"
      >
        <DisplayText text={state.data.summary} />
        {state.data.needsYou ? (
          <p className="m-0 border-t border-dashboard-accent/15 pt-2.5">
            <span className="font-semibold text-dashboard-accent-text">
              Needs you
            </span>
            <span
              aria-hidden="true"
              className="px-1.5 text-dashboard-text-muted"
            >
              ·
            </span>
            {state.data.needsYou}
          </p>
        ) : null}
        {jumpToLatest ? (
          <Button
            className="-mb-1 -ml-2 h-7 justify-self-start gap-1.5 px-2 text-xs"
            onClick={jumpToLatest}
            variant="quiet"
          >
            <ArrowDown aria-hidden="true" size={14} strokeWidth={2} />
            Jump to latest
          </Button>
        ) : null}
      </div>
    );
  }
  if (state?.pending) {
    return (
      <div
        aria-label="Summarizing new messages"
        className={cardClass}
        ref={cardRef}
        role="status"
      >
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }
  return null;
}
