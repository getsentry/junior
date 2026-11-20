// The model request of a Turn step, through AI Gateway. It uses the traced
// stream of the chat agent loop, so each request gets the same `gen_ai.chat`
// span. The reply carries its usage and cost, and the step commit saves the
// reply in history, where Conversation usage reads it.
import { getGatewayApiKey, resolveGatewayModel } from "@/chat/pi/client";
import { createTracedStreamFn } from "@/chat/pi/traced-stream";
import {
  toPiReasoningLevel,
  type TurnReasoningLevel,
} from "@/chat/reasoning-level";
import type { StepInput } from "@/core/turn/step";

/**
 * Make the model request of a Turn step for one AI Gateway model. A failed or
 * aborted request returns pi-ai's reply with `stopReason` `error` or
 * `aborted`. It does not retry.
 */
export function createGatewayComplete(options: {
  modelId: string;
  reasoningLevel: TurnReasoningLevel;
  /** AI Gateway keeps the requests of one Conversation in one session. */
  conversationId: string;
}): StepInput["complete"] {
  const model = resolveGatewayModel(options.modelId);
  const thinkingLevel = toPiReasoningLevel(options.reasoningLevel);
  const stream = createTracedStreamFn();
  return async (context, signal) => {
    const response = await stream(model, context, {
      // Resolve on every request so runtime OIDC tokens stay fresh.
      apiKey: await getGatewayApiKey(),
      sessionId: options.conversationId,
      reasoning: thinkingLevel === "off" ? undefined : thinkingLevel,
      signal,
    });
    return response.result();
  };
}
