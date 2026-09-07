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

/** Resolve tool input to the Slack Destinations stored on a task. */
export async function resolveTaskOutcomes(
  outcomes: TaskOutcomeInput[] | undefined,
  currentDestination: SlackDestination,
  creatorSlackUserId: string,
): Promise<TaskOutcome[]> {
  if (outcomes === undefined) {
    return [{ action: "send_message", destination: currentDestination }];
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
        destination: outcome.destination,
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

/** Return stored outcomes, or preserve the legacy message Destination. */
export function effectiveTaskOutcomes(
  outcomes: TaskOutcome[] | undefined,
  destination: SlackDestination,
): TaskOutcome[] {
  return (
    outcomes ?? [
      {
        action: "send_message",
        destination,
      },
    ]
  );
}
