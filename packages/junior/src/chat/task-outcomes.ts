import {
  actorUserIdSchema,
  slackDestinationSchema,
  type SlackDestination,
  type TaskOutcome,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import { getSlackClient, withSlackRetries } from "@/chat/slack/client";

const taskMessageDestinationInputSchema = z.union([
  slackDestinationSchema,
  z
    .object({
      platform: z.literal("slack"),
      teamId: z.string().min(1),
      userId: actorUserIdSchema,
    })
    .strict(),
]);

/** Input accepted by task authoring tools before a user becomes a DM Destination. */
export const taskOutcomeInputSchema = z
  .object({
    action: z.literal("send_message"),
    destination: taskMessageDestinationInputSchema,
  })
  .strict();

export type TaskOutcomeInput = z.output<typeof taskOutcomeInputSchema>;

/** Resolve explicit message outcomes to the Slack Destinations stored on an Automation. */
export async function resolveTaskOutcomes(
  outcomes: TaskOutcomeInput[] | undefined,
  currentDestination: SlackDestination,
  creatorSlackUserId: string,
): Promise<TaskOutcome[]> {
  if (outcomes === undefined) {
    return [];
  }
  const resolved: TaskOutcome[] = [];
  for (const outcome of outcomes) {
    if (outcome.destination.teamId !== currentDestination.teamId) {
      throw new Error(
        "Message destinations must be in the current Slack workspace.",
      );
    }
    if ("channelId" in outcome.destination) {
      if (outcome.destination.channelId !== currentDestination.channelId) {
        throw new Error(
          "Messages can only be sent to the current Slack conversation or the task creator.",
        );
      }
      resolved.push({
        action: "send_message",
        destination: currentDestination,
      });
      continue;
    }
    const userId = outcome.destination.userId;
    if (userId !== creatorSlackUserId) {
      throw new Error("Direct messages can only be sent to the task creator.");
    }
    const response = await withSlackRetries(
      () =>
        getSlackClient().conversations.open({
          users: userId,
        }),
      3,
      { action: "conversations.open" },
    );
    const channelId = response.channel?.id;
    if (!channelId) {
      throw new Error("Slack did not return a direct message destination.");
    }
    resolved.push({
      action: "send_message",
      destination: {
        platform: "slack",
        teamId: currentDestination.teamId,
        channelId,
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
