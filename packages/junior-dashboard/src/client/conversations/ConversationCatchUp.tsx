import { useContext } from "react";
import { ArrowDown } from "lucide-react";

import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { InlineError } from "../components/InlineError";
import { DisplayText } from "../display-text/DisplayText";
import { useConversationCatchUpState } from "./conversationCatchUpState";
import { TranscriptJumpToLatestContext } from "./transcriptBottomPinning";

const cardClass =
  "grid gap-2 rounded-lg border border-dashboard-border bg-dashboard-surface-raised px-3 py-2.5 font-sans text-sm text-dashboard-text";

/** Offer the catch-up inside the "New" marker, so it takes no extra row. */
export function ConversationCatchUpButton() {
  const state = useConversationCatchUpState();
  if (!state || state.data || state.pending) return null;
  return (
    <>
      <Button
        className="h-6 px-2 text-xs"
        onClick={state.request}
        variant="quiet"
      >
        Catch me up
      </Button>
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
  if (state?.data) {
    return (
      <div aria-label="Catch-up" className={cardClass} role="group">
        <DisplayText text={state.data.summary} />
        {state.data.needsYou ? (
          <p className="m-0">
            <span className="font-semibold text-dashboard-accent-text">
              Needs you:
            </span>{" "}
            {state.data.needsYou}
          </p>
        ) : null}
        {jumpToLatest ? (
          <Button
            className="h-7 justify-self-start gap-1.5 px-2 text-xs"
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
        role="status"
      >
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }
  return null;
}
