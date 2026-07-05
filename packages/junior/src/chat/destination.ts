import {
  destinationSchema,
  type Destination,
  type SlackDestination,
} from "@sentry/junior-plugin-api";
import {
  parseSlackChannelReferenceId,
  parseSlackTeamId,
} from "@/chat/slack/ids";

/** Build Junior's canonical destination from Slack workspace and channel ids. */
export function createSlackDestination(input: {
  channelId: string | undefined;
  teamId: string | undefined;
}): Destination | undefined {
  const channelId = parseSlackChannelReferenceId(input.channelId);
  const teamId = parseSlackTeamId(input.teamId);
  if (!channelId || !teamId) {
    return undefined;
  }
  return { platform: "slack", teamId, channelId };
}

/** Parse and validate a serialized destination that crossed a runtime boundary. */
export function parseDestination(value: unknown): Destination | undefined {
  const parsed = destinationSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Require a Slack destination at a Slack-only runtime boundary. */
export function requireSlackDestination(
  destination: Destination | undefined,
  action: string,
): SlackDestination {
  if (destination?.platform === "slack") {
    return destination;
  }
  throw new Error(`${action} requires a Slack destination`);
}

/** Compare two destinations without relying on object identity. */
export function sameDestination(
  left: Destination,
  right: Destination,
): boolean {
  if (left.platform !== right.platform) {
    return false;
  }
  if (left.platform === "local" && right.platform === "local") {
    return left.conversationId === right.conversationId;
  }
  if (left.platform === "slack" && right.platform === "slack") {
    return left.teamId === right.teamId && left.channelId === right.channelId;
  }
  return false;
}

/** Return the lock/index-safe storage key for a destination. */
export function destinationKey(destination: Destination): string {
  if (destination.platform === "local") {
    return destination.conversationId;
  }
  return `slack:${destination.teamId}:${destination.channelId}`;
}
