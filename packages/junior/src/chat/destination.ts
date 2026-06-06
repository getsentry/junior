import type { Destination } from "@sentry/junior-plugin-api";
import { isRecord } from "@/chat/coerce";
import { normalizeSlackConversationId } from "@/chat/slack/client";
import { isSlackConversationId, isSlackTeamId } from "@/chat/slack/ids";

function hasOnlyDestinationKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).every(
    (key) => key === "platform" || key === "teamId" || key === "channelId",
  );
}

/** Build Junior's canonical destination from Slack workspace and channel ids. */
export function createSlackDestination(input: {
  channelId: string | undefined;
  teamId: string | undefined;
}): Destination | undefined {
  const channelId = normalizeSlackConversationId(input.channelId);
  const teamId = input.teamId?.trim();
  if (!channelId || !teamId) {
    return undefined;
  }
  if (!isSlackConversationId(channelId) || !isSlackTeamId(teamId)) {
    return undefined;
  }
  return { platform: "slack", teamId, channelId };
}

/** Parse and validate a serialized destination that crossed a runtime boundary. */
export function parseDestination(value: unknown): Destination | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyDestinationKeys(value) ||
    value.platform !== "slack"
  ) {
    return undefined;
  }
  if (
    typeof value.channelId !== "string" ||
    typeof value.teamId !== "string" ||
    !isSlackConversationId(value.channelId) ||
    !isSlackTeamId(value.teamId)
  ) {
    return undefined;
  }
  return {
    platform: "slack",
    teamId: value.teamId,
    channelId: value.channelId,
  };
}

/** Compare two destinations without relying on object identity. */
export function sameDestination(
  left: Destination,
  right: Destination,
): boolean {
  return (
    left.platform === right.platform &&
    left.teamId === right.teamId &&
    left.channelId === right.channelId
  );
}

/** Return the lock/index-safe storage key for a destination. */
export function destinationKey(destination: Destination): string {
  return `slack:${destination.teamId}:${destination.channelId}`;
}
