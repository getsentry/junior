import type {
  ReplyAttribution,
  SlackDestination,
  TaskOutcome,
} from "@sentry/junior-plugin-api";
import { createOrGetDispatch } from "@/chat/agent-dispatch/store";
import type { BoundDispatchOptions } from "@/chat/agent-dispatch/types";
import type { CredentialSubject } from "@/chat/credentials/context";

export const agentDispatchTestDestination = {
  platform: "slack",
  teamId: "T123",
  channelId: "C123",
} as const;

/** Create a durable dispatch record for integration tests. */
export async function createAgentDispatchTestRecord(
  idempotencyKey: string,
  credentialSubject?: CredentialSubject,
  source?: BoundDispatchOptions["source"],
  replyAttribution?: ReplyAttribution,
  input = "Post the scheduled digest.",
  outcomes?: TaskOutcome[],
  destination: SlackDestination = agentDispatchTestDestination,
) {
  return (
    await createOrGetDispatch({
      nowMs: Date.now(),
      options: {
        destination,
        destinationVisibility: "private",
        ...(credentialSubject ? { credentialSubject } : undefined),
        idempotencyKey,
        input,
        ...(replyAttribution ? { replyAttribution } : undefined),
        source: source ?? { kind: "scheduled_automation" },
        ...(outcomes ? { outcomes } : undefined),
      },
      plugin: "scheduler",
    })
  ).record;
}
