import type { Context, Message } from "@earendil-works/pi-ai";
import { vi } from "vitest";
import type { BotConfig } from "@/chat/config";
import { botConfig } from "@/chat/config";
import type { ConversationEvent } from "@/chat/conversations/history";
import { loadProjection } from "@/chat/conversations/projection";
import { getConversationEventStore } from "@/chat/db";
import type { PiMessage } from "@/chat/pi/messages";
import { createConversationWebHarness } from "./conversation";
import { createModelStream } from "./model-stream";

type ModelInput = Pick<Context, "systemPrompt"> & { messages: Message[] };

type Agent = {
  events(): Promise<ConversationEvent[]>;
  messages(): Promise<PiMessage[]>;
  run(prompt: string): Promise<void>;
  snapshot(): ModelInput;
};

type AgentOptions = {
  botConfig?: Partial<BotConfig>;
  history?: Array<{ prompt: string; reply: string }>;
  replies?: string[];
};

/** Create an Agent that runs complete Conversation Turns through production code. */
export async function createAgent(options: AgentOptions = {}): Promise<Agent> {
  Object.assign(botConfig, options.botConfig);
  const history = options.history ?? [];
  const replies = [
    ...history.map((entry) => entry.reply),
    ...(options.replies ?? ["First reply.", "Second reply."]),
  ];
  const model = vi.fn(
    createModelStream(
      replies.map((text) => ({
        type: "text" as const,
        text,
      })),
    ),
  );
  const conversation = await createConversationWebHarness(model);
  let conversationId: string | undefined;
  let turn = 0;

  const agent: Agent = {
    async events() {
      if (!conversationId) throw new Error("No conversation to inspect");
      return await getConversationEventStore().loadHistory(conversationId);
    },
    async messages() {
      if (!conversationId) throw new Error("No conversation to inspect");
      return await loadProjection({ conversationId });
    },
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
      return {
        systemPrompt: context.systemPrompt,
        messages: structuredClone(context.messages),
      };
    },
  };

  for (const entry of history) {
    await agent.run(entry.prompt);
  }
  return agent;
}
