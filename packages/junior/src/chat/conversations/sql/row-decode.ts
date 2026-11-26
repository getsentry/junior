import type { Destination } from "@sentry/junior-plugin-api";
import { parseDestination } from "@/chat/destination";
import type { ConversationSource, ConversationStatus } from "../store";
import type { juniorDestinations } from "@/db/schema";

type DestinationRow = typeof juniorDestinations.$inferSelect;

/** Read an optional SQL timestamp as epoch milliseconds. */
export function msFromDate(
  value: Date | string | null | undefined,
): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const date = value instanceof Date ? value : new Date(value);
  return date.getTime();
}

/** Read a required SQL timestamp as epoch milliseconds. */
export function requiredMsFromDate(value: Date | string): number {
  const ms = msFromDate(value);
  if (typeof ms !== "number" || Number.isNaN(ms)) {
    throw new Error("Conversation record timestamp is invalid");
  }
  return ms;
}

/** Read a stored Conversation source, or undefined when it is unknown. */
export function sourceFromValue(
  value: unknown,
): ConversationSource | undefined {
  if (
    value === "api" ||
    value === "internal" ||
    value === "local" ||
    value === "plugin" ||
    value === "event" ||
    value === "scheduler" ||
    value === "slack" ||
    value === "web"
  ) {
    return value;
  }
  return undefined;
}

/** Read a stored execution status, and reject an invalid one. */
export function executionStatusFromValue(value: unknown): ConversationStatus {
  if (
    value === "failed" ||
    value === "idle" ||
    value === "paused" ||
    value === "pending" ||
    value === "running"
  ) {
    return value;
  }
  throw new Error("Conversation record execution status is invalid");
}

/** Read the Destination of a stored Destination row. */
export function destinationFromRow(
  destination: DestinationRow | null,
): Destination | undefined {
  const value =
    destination?.provider === "slack"
      ? {
          platform: "slack",
          teamId: destination.providerTenantId,
          channelId: destination.providerDestinationId,
        }
      : destination?.provider === "local"
        ? {
            platform: "local",
            conversationId: destination.providerDestinationId,
          }
        : undefined;
  return parseDestination(value);
}
