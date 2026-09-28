import type {
  AutomationSummary,
  AutomationUpdate,
} from "@sentry/junior/api/schema";

type Outcome = NonNullable<AutomationUpdate["outcomes"]>[number];

/** Describe a retained Destination without guessing a recipient from a private id. */
export function automationOutcomeLabel(
  outcome: Outcome,
  destination: AutomationSummary["destination"],
): string {
  if (typeof outcome.destination === "string")
    return outcome.destination === "task_creator"
      ? "Creator · Direct message"
      : `${destination.label} · ${destination.visibility}`;
  if (
    outcome.destination.channelId === destination.channelId &&
    outcome.destination.teamId === destination.teamId
  )
    return `${destination.label} · ${destination.visibility}`;
  return `Saved destination · ${outcome.destination.channelId}`;
}
