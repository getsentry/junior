import type { Message } from "@earendil-works/pi-ai";
import { toCanonicalInputMessage } from "@/chat/conversation-privacy";
import { createConversationWebHarness } from "./conversation";
import { createModelStream } from "./model-stream";

export type Agent = {
  /** Run one complete Turn with the given prompt. */
  run: (prompt: string) => Promise<void>;
  /** Copy the canonical Messages sent in the latest model request. */
  snapshot: () => Record<string, unknown>[];
};

/** Run complete Conversation Turns through production composition. */
export async function createAgent(): Promise<Agent> {
  const modelRequests: Message[][] = [];
  const conversation = await createConversationWebHarness(
    createModelStream(
      ["First reply.", "Second reply."].map((text) => ({
        type: "text" as const,
        text,
        onRequest: (context) => {
          modelRequests.push(structuredClone(context.messages));
        },
      })),
    ),
  );
  let conversationId: string | undefined;
  let turn = 0;

  return {
    run: async (prompt) => {
      turn += 1;
      if (conversationId) {
        await conversation.continue({
          conversationId,
          idempotencyKey: `turn-${turn}`,
          message: prompt,
        });
      } else {
        const started = await conversation.start({
          idempotencyKey: `turn-${turn}`,
          message: prompt,
        });
        conversationId = started.conversationId;
      }
      await conversation.drain();
    },
    snapshot: () => {
      const messages = modelRequests.at(-1);
      if (!messages) {
        throw new Error("Agent has not sent a model request");
      }
      return structuredClone(messages.map(toCanonicalInputMessage));
    },
  };
}
