import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { InlineError } from "../components/InlineError";
import { DisplayText } from "../display-text/DisplayText";
import { useConversationCatchUpState } from "./conversationCatchUpState";

const cardClass =
  "grid gap-2 rounded-lg border border-dashboard-border bg-dashboard-surface-raised px-3 py-2.5 font-sans text-sm text-dashboard-text";

/** Offer, load, and show the catch-up under the "New" marker. */
export function ConversationCatchUp() {
  const state = useConversationCatchUpState();
  if (!state) return null;
  if (state.data) {
    return (
      <div className={cardClass}>
        <DisplayText text={state.data.summary} />
        {state.data.needsYou ? (
          <p className="m-0">
            <span className="font-semibold text-dashboard-accent-text">
              Needs you:
            </span>{" "}
            {state.data.needsYou}
          </p>
        ) : null}
      </div>
    );
  }
  if (state.pending) {
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
  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      <Button onClick={state.request} variant="quiet">
        Catch me up
      </Button>
      {state.error ? (
        <InlineError className="text-xs">
          The summary failed. Try again.
        </InlineError>
      ) : null}
    </div>
  );
}
