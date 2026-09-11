import type { Message } from "@earendil-works/pi-ai";
import { vi } from "vitest";
import { createConversationWebHarness } from "./conversation";
import { createModelStream } from "./model-stream";

type Agent = {
  run(prompt: string): Promise<void>;
  snapshot(): Message[];
};

/** Create an Agent that runs complete Conversation Turns through production code. */
export async function createAgent(): Promise<Agent> {
  const model = vi.fn(
    createModelStream(
      ["First reply.", "Second reply."].map((text) => ({
        type: "text" as const,
        text,
      })),
    ),
  );
  const conversation = await createConversationWebHarness(model);
  let conversationId: string | undefined;
  let turn = 0;

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
      const context = model.mock.lastCall?.[1];
      if (!context) throw new Error("No model request to snapshot");
      return structuredClone(context.messages);
    },
  };
}
