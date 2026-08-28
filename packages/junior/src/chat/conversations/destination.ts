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
 * Location, and web and resource-event Turns no longer need a local
 * Destination.
 */
export function resolveConversationDestination(args: {
  conversationId: string;
  existing?: Destination;
}): Destination {
  return args.existing ?? requireLocalDestination(args.conversationId);
}
