import { createHash } from "node:crypto";
import {
  localDestinationSchema,
  type Destination,
  type LocalDestination,
} from "@sentry/junior-plugin-api";

function requireLocalDestination(conversationId: string): LocalDestination {
  const parsed = localDestinationSchema.safeParse({
    platform: "local",
    conversationId,
  });
  if (!parsed.success) {
    throw new Error(`Invalid local conversation id: ${conversationId}`);
  }
  return parsed.data;
}

/**
 * Keep a stored Destination, or create the temporary local Destination.
 *
 * TODO(dcramer): Delete this module after Conversation and AgentRun use
 * Location, and web and event Turns no longer need a local
 * Destination.
 */
export function resolveConversationDestination(args: {
  conversationId: string;
  existing?: Destination | undefined;
}): Destination {
  return args.existing ?? requireLocalDestination(args.conversationId);
}

/**
 * Create the local Destination of a Conversation that needs its own, such as
 * one that leaves its Space. A local id is its own Destination. Another id,
 * such as a child agent's or a Slack thread's, maps to a stable local one.
 */
export function ownLocalDestination(conversationId: string): LocalDestination {
  const own = localDestinationSchema.safeParse({
    platform: "local",
    conversationId,
  });
  if (own.success) return own.data;
  const hex = createHash("sha256")
    .update(conversationId)
    .digest("hex")
    .slice(0, 32);
  return requireLocalDestination(`local:conversation:${hex}`);
}
