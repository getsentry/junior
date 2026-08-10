import type { StateAdapter } from "chat";
import type { Destination } from "@sentry/junior-plugin-api";
import type { WebActor } from "@/chat/actor";
import type { ConversationStore } from "@/chat/conversations/store";
import { closeDb, getConversationStore } from "@/chat/db";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import type { ConversationWorkerContext } from "@/chat/task-execution/worker";
import {
  createConversationWorkQueueTestAdapter,
  type ConversationWorkQueueTestAdapter,
} from "./conversation-work";
import { deliverAssistantMessagesForTest } from "./agent-runner";

/** Default verified dashboard viewer for web turn tests. */
export const apiTurnTestActor = {
  platform: "web",
  userId: "dashboard:alice",
  email: "alice@example.com",
  fullName: "Alice Example",
  userName: "alice",
} as const satisfies WebActor;

export type ApiTurnWorkFixture = {
  actor: typeof apiTurnTestActor;
  conversationStore: ConversationStore;
  queue: ConversationWorkQueueTestAdapter;
  state: StateAdapter;
};

/**
 * Wire the standard product store + queue + state path for web turn tests.
 *
 * Callers should run `closeApiTurnWorkFixture` from `afterEach`.
 */
export async function createApiTurnWorkFixture(): Promise<ApiTurnWorkFixture> {
  const conversationStore = getConversationStore();
  const queue = createConversationWorkQueueTestAdapter();
  const state = getStateAdapter();
  await state.connect();
  return {
    actor: apiTurnTestActor,
    conversationStore,
    queue,
    state,
  };
}

/** Release state + SQL handles opened by `createApiTurnWorkFixture`. */
export async function closeApiTurnWorkFixture(): Promise<void> {
  await disconnectStateAdapter();
  await closeDb();
}

/** Empty-mailbox worker attempt used by resume-routing cases. */
export function emptyApiTurnAttempt(args: {
  conversationId: string;
  destination: Destination;
}): ConversationWorkerContext["attempt"] {
  return {
    ack: async () => undefined,
    conversationId: args.conversationId,
    destination: args.destination,
    drain: async () => [],
    isFinalAttempt: false,
    messages: [],
  };
}

/**
 * Script one completed assistant reply through the production delivery port.
 */
export function createApiTurnScriptedRunner(args: {
  replyText: string;
  onRun?: (request: Parameters<AgentRunner["run"]>[0]) => void | Promise<void>;
}): AgentRunner {
  return {
    run: async (request) => {
      await args.onRun?.(request);
      const piMessages = await deliverAssistantMessagesForTest(request, [
        { text: args.replyText },
      ]);
      return completedAgentRun({
        text: args.replyText,
        piMessages,
        diagnostics: {
          assistantMessageCount: 1,
          modelId: "fake-api-turn",
          outcome: "success",
          toolCalls: [],
          toolErrorCount: 0,
          toolResultCount: 0,
          usedPrimaryText: true,
        },
      });
    },
  };
}
