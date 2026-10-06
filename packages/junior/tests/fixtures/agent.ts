import type { Context, Message } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
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

type AgentFixture = {
  agentHistory(): Promise<PiMessage[]>;
  historyEvents(): Promise<ConversationEvent[]>;
  run(prompt: string): Promise<void>;
  snapshot(): ModelInput;
};

type PreviousTurn = {
  prompt: string;
  response: string;
};

type AgentFixtureOptions = {
  botConfig?: Partial<BotConfig>;
  previousTurns?: PreviousTurn[];
  responses?: string[];
  modelStream?: StreamFn;
};

/**
 * Create an Agent fixture through the production Conversation path.
 *
 * `previousTurns` runs before this function returns. This gives tests durable
 * agent history without bypassing Turn execution or SQL history.
 */
export async function createAgent(
  options: AgentFixtureOptions = {},
): Promise<AgentFixture> {
  Object.assign(botConfig, options.botConfig);
  const previousTurns = options.previousTurns ?? [];
  const responses = [
    ...previousTurns.map((turn) => turn.response),
    ...(options.responses ?? ["First response.", "Second response."]),
  ];
  const model = vi.fn(
    options.modelStream ??
      createModelStream(
        responses.map((text) => ({ type: "text" as const, text })),
      ),
  );
  const conversation = await createConversationWebHarness(model);
  let conversationId: string | undefined;
  let turn = 0;

  const agent: AgentFixture = {
    async agentHistory() {
      if (!conversationId) throw new Error("No conversation to inspect");
      return await loadProjection({ conversationId });
    },
    async historyEvents() {
      if (!conversationId) throw new Error("No conversation to inspect");
      return await getConversationEventStore().loadHistory(conversationId);
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

  for (const turn of previousTurns) {
    await agent.run(turn.prompt);
  }
  return agent;
}
