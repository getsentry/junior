import type { Message } from "@earendil-works/pi-ai";
import {
  appendAndEnqueueWebMessage,
  createConversationId,
} from "@/chat/conversations/web-input";
import { createConversationTurnWorker } from "@/chat/task-execution/conversation-turn";
import {
  resolveMailboxTurnWork,
  type MailboxTurnWork,
} from "@/chat/task-execution/mailbox-turn";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import type {
  ConversationWorkerContext,
  ConversationWorkerResult,
} from "@/chat/task-execution/worker";
import { createModelAgentRunner } from "./agent-runner";
import { createConversationFixture } from "./conversation";
import { createModelStream } from "./model-stream";

export type Agent = {
  /** Run one complete Turn with the given prompt. */
  run: (prompt: string) => Promise<void>;
  /** Copy the Messages sent in the latest model request. */
  snapshot: () => Message[];
};

function requireConversationTurn(
  worker: (
    context: ConversationWorkerContext,
    resolved: MailboxTurnWork,
  ) => Promise<ConversationWorkerResult>,
) {
  return async (
    context: ConversationWorkerContext,
  ): Promise<ConversationWorkerResult> => {
    const resolved = await resolveMailboxTurnWork(context);
    if (!resolved) {
      throw new Error("Expected Conversation mailbox work");
    }
    return await worker(context, resolved);
  };
}

/** Run complete Conversation Turns through the real agent path. */
export async function createAgent(): Promise<Agent> {
  const { actor, conversationStore, queue, state } =
    await createConversationFixture();
  const conversationId = createConversationId({
    actorEmail: actor.email,
    idempotencyKey: "agent-fixture",
  });
  const modelRequests: Message[][] = [];
  const agentRunner = createModelAgentRunner(
    createModelStream(
      Array.from({ length: 12 }, () => ({
        type: "text" as const,
        text: "Done.",
        onRequest: (context) => {
          modelRequests.push(structuredClone(context.messages));
        },
      })),
    ),
  );
  const runTurn = requireConversationTurn(
    createConversationTurnWorker(agentRunner),
  );
  let turn = 0;

  return {
    run: async (prompt) => {
      turn += 1;
      await appendAndEnqueueWebMessage(
        {
          actor,
          conversationId,
          idempotencyKey: `turn-${turn}`,
          message: prompt,
        },
        { conversationStore, queue, state },
      );
      for (let i = 0; i < 12 && queue.hasQueuedMessages(); i += 1) {
        await processConversationQueueMessage(queue.takeMessage(), {
          conversationStore,
          queue,
          run: runTurn,
          state,
        });
      }
      if (queue.hasQueuedMessages()) {
        throw new Error("Queue still has work after Turn");
      }
    },
    snapshot: () => {
      const messages = modelRequests.at(-1);
      if (!messages) {
        throw new Error("Agent has not sent a model request");
      }
      return structuredClone(messages);
    },
  };
}
