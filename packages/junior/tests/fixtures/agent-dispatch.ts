import {
  createSlackSource,
  type ReplyAttribution,
  type Source,
} from "@sentry/junior-plugin-api";
import { createOrGetDispatch } from "@/chat/agent-dispatch/store";
import { createConversationWork } from "@/chat/app/conversation-work";
import { createJuniorSlackAdapter } from "@/chat/slack/adapter";
import type { CredentialSubject } from "@/chat/credentials/context";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { getConversationStore } from "@/chat/db";
import { getStateAdapter } from "@/chat/state/adapter";
import { createConversationWorkQueueTestAdapter } from "./conversation-work";

export const agentDispatchTestDestination = {
  platform: "slack",
  teamId: "T123",
  channelId: "C123",
} as const;

/** Compose production conversation work for one agent dispatch test. */
export async function createAgentDispatchWorkHarness(agentRunner: AgentRunner) {
  const state = getStateAdapter();
  await state.connect();
  const queue = createConversationWorkQueueTestAdapter();
  const adapter = createJuniorSlackAdapter({
    botToken: "xoxb-test",
    botUserId: "U0BOT",
    signingSecret: "test-signing-secret",
  });
  const work = createConversationWork({
    agentRunner,
    conversationStore: getConversationStore(),
    getSlackAdapter: () => adapter,
    queue,
    state,
  });
  return { queue, run: work.run, runtime: work.runtime, state };
}

/** Create a durable dispatch record for integration tests. */
export async function createAgentDispatchTestRecord(
  idempotencyKey: string,
  credentialSubject?: CredentialSubject,
  source?: Source,
  replyAttribution?: ReplyAttribution,
  input = "Post the scheduled digest.",
) {
  return (
    await createOrGetDispatch({
      nowMs: Date.now(),
      options: {
        destination: agentDispatchTestDestination,
        destinationVisibility: "private",
        ...(credentialSubject ? { credentialSubject } : undefined),
        idempotencyKey,
        input,
        ...(replyAttribution ? { replyAttribution } : undefined),
        source:
          source ??
          createSlackSource({
            ...agentDispatchTestDestination,
            visibility: "private",
          }),
      },
      plugin: "scheduler",
    })
  ).record;
}
