import type { Message } from "@earendil-works/pi-ai";
import { onTestFinished } from "vitest";
import { toCanonicalInputMessage } from "@/chat/conversation-privacy";
import {
  closeConversationFixture,
  createConversationWebHarness,
} from "./conversation";
import { createModelStream } from "./model-stream";

type Agent = {
  run(prompt: string): Promise<void>;
  snapshot(): Record<string, unknown>[];
};

/** Create an Agent that runs complete Conversation Turns through production code. */
export async function createAgent(): Promise<Agent> {
  const modelRequests: Message[][] = [];
  const conversation = await createConversationWebHarness(
    createModelStream(
      ["First reply.", "Second reply."].map((text) => ({
        type: "text" as const,
        text,
        onRequest: ({ messages }) =>
          modelRequests.push(structuredClone(messages)),
      })),
    ),
  );
  let conversationId: string | undefined;
  let turn = 0;

  onTestFinished(closeConversationFixture);

  return {
    async run(prompt) {
      turn += 1;
      // TODO(dcramer): Remove this web start/continue choice when the shared
      // Conversation fixture can run consecutive prompts directly.
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
    snapshot() {
      const messages = modelRequests.at(-1);
      if (!messages) throw new Error("No model request to snapshot");
      return structuredClone(messages.map(toCanonicalInputMessage));
    },
  };
}
