import type { TaskOutcomeInput } from "./task-outcomes-schema";
import type { SlackDestination, TaskOutcome } from "@sentry/junior-plugin-api";
import { openSlackDirectMessage } from "@/chat/slack/outbound";

/** Resolve explicit message outcomes to the Slack Destinations stored on an Automation. */
export async function resolveTaskOutcomes(
  outcomes: TaskOutcomeInput[] | undefined,
  currentDestination: SlackDestination,
  creatorSlackUserId: string,
): Promise<TaskOutcome[]> {
  if (outcomes === undefined) {
    return [];
  }
  // Every direct-message outcome goes to the same creator, so open the DM once.
  const directMessageChannelId = outcomes.some(
    (outcome) => outcome.destination !== "current_conversation",
  )
    ? await openSlackDirectMessage(creatorSlackUserId)
    : undefined;
  const resolved: TaskOutcome[] = [];
  for (const outcome of outcomes) {
    if (outcome.destination === "current_conversation") {
      resolved.push({
        action: "send_message",
        destination: currentDestination,
      });
      continue;
    }
    if (!directMessageChannelId) continue;
    resolved.push({
      action: "send_message",
      destination: {
        platform: "slack",
        teamId: currentDestination.teamId,
        channelId: directMessageChannelId,
      },
    });
  }
  return resolved;
}

function outcomeTargetsDestination(
  outcome: TaskOutcome,
  destination: SlackDestination,
): boolean {
  return (
    outcome.destination.teamId === destination.teamId &&
    outcome.destination.channelId === destination.channelId &&
    (!outcome.destination.threadTs ||
      outcome.destination.threadTs === destination.threadTs)
  );
}

/** Bind same-channel message outcomes to the Automation Destination. */
export function effectiveTaskOutcomes(
  outcomes: TaskOutcome[],
  destination: SlackDestination,
): TaskOutcome[] {
  return outcomes.map((outcome) =>
    destination.threadTs && outcomeTargetsDestination(outcome, destination)
      ? {
          ...outcome,
          destination,
        }
      : outcome,
  );
}

/** Move outcomes that target the task Destination and keep other outcomes unchanged. */
export function moveTaskOutcomes(
  outcomes: TaskOutcome[],
  currentDestination: SlackDestination,
  nextDestination: SlackDestination,
): TaskOutcome[] {
  return effectiveTaskOutcomes(outcomes, currentDestination).map((outcome) =>
    outcomeTargetsDestination(outcome, currentDestination)
      ? { ...outcome, destination: nextDestination }
      : outcome,
  );
}
