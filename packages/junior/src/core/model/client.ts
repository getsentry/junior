// The model calls of core. The host builds one client from its credentials
// and model catalog, and passes it to the Turn engine. Each request carries
// its own settings, so one client serves every Turn.
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
} from "@earendil-works/pi-ai";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import { createTracedStreamFn } from "@/chat/pi/traced-stream";
import {
  toPiReasoningLevel,
  type TurnReasoningLevel,
} from "@/chat/reasoning-level";

/** The model that a Turn uses, and how its requests are recorded. */
export type ModelSettings = {
  id: string;
  reasoning: TurnReasoningLevel;
  /** `public` records message content on spans. */
  privacy: ConversationPrivacy;
};

/** One model request. */
export type ModelRequest = {
  model: ModelSettings;
  /** Keeps the requests of one Conversation together, for the prompt cache. */
  session: string;
  context: Context;
};

/** The model calls that core makes. */
export type ModelClient = {
  /**
   * Makes one model request. A failed or aborted request returns its reply
   * with `stopReason` `error` or `aborted`. It does not retry.
   */
  complete: (
    request: ModelRequest,
    signal: AbortSignal,
  ) => Promise<AssistantMessage>;
};

/**
 * Builds the model client. `apiKey` runs before each request, because a
 * credential can rotate between requests.
 */
export function modelClient(dependencies: {
  apiKey: () => Promise<string>;
  resolveModel: (id: string) => Model<Api>;
}): ModelClient {
  return {
    complete: async ({ model, session, context }, signal) => {
      const reasoning = toPiReasoningLevel(model.reasoning);
      // The traced stream of the chat agent loop, so each request gets the
      // same `gen_ai.chat` span.
      const stream = await createTracedStreamFn({
        conversationPrivacy: model.privacy,
      })(dependencies.resolveModel(model.id), context, {
        apiKey: await dependencies.apiKey(),
        sessionId: session,
        reasoning: reasoning === "off" ? undefined : reasoning,
        signal,
      });
      return stream.result();
    },
  };
}
