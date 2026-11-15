import type {
  ActorIdentity,
  ConversationDetailReport,
} from "@sentry/junior/api/schema";

import { ClampedPreview } from "../components/ClampedPreview";
import { StatusChip, type StatusChipTone } from "../components/StatusChip";
import { DisplayText } from "../display-text/DisplayText";

type OutcomeStatus = NonNullable<ConversationDetailReport["outcomeStatus"]>;

const SUMMARY_PREVIEW_LINES = 4;

const outcomeTones: Record<OutcomeStatus, StatusChipTone> = {
  abandoned: "neutral",
  answered: "info",
  blocked: "danger",
  done: "success",
  in_progress: "accent",
  partial: "warning",
};

/**
 * Show the summary of a Conversation: clamped in details, in full with its
 * outcome status when the transcript expired.
 */
export function ConversationSummary(props: {
  mentions?: readonly ActorIdentity[] | undefined;
  outcomeStatus?: OutcomeStatus | undefined;
  summary: string;
  variant?: "preview" | "full";
}) {
  if (props.variant !== "full") {
    return (
      <ClampedPreview
        className="leading-6"
        label="Summary"
        lines={SUMMARY_PREVIEW_LINES}
      >
        <DisplayText compact mentions={props.mentions} text={props.summary} />
      </ClampedPreview>
    );
  }
  return (
    <div className="grid min-w-0 gap-3">
      {props.outcomeStatus ? (
        <div>
          <StatusChip tone={outcomeTones[props.outcomeStatus]}>
            {props.outcomeStatus.replaceAll("_", " ")}
          </StatusChip>
        </div>
      ) : null}
      <DisplayText mentions={props.mentions} text={props.summary} />
    </div>
  );
}
