import type { ActorIdentity } from "@sentry/junior/api/schema";

import { ClampedPreview } from "../components/ClampedPreview";
import { DisplayText } from "../display-text/DisplayText";

const SUMMARY_PREVIEW_LINES = 4;

/**
 * Show the summary of a Conversation: clamped in details, in full when the
 * transcript expired.
 */
export function ConversationSummary(props: {
  mentions?: readonly ActorIdentity[] | undefined;
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
  return <DisplayText mentions={props.mentions} text={props.summary} />;
}
