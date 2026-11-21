// The model calls of core. The host builds one client from its credentials
// and model catalog, and passes it to the Turn engine. Each request carries
// its own settings, so one client serves every Turn.
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
// Core uses chat's traced stream, so the model span stays identical to main's.
// It moves into core when core replaces chat's agent loop.
import { createTracedStreamFn } from "@/chat/pi/traced-stream";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import {
  toPiReasoningLevel,
  type TurnReasoningLevel,
} from "@/chat/reasoning-level";

/** Sends one model request and streams the reply. */
type SendModelRequest = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

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
 * credential can rotate between requests. `send` sends the request, such as
 * pi-ai's `streamSimple`.
 */
export function modelClient(dependencies: {
  apiKey: () => Promise<string>;
  resolveModel: (id: string) => Model<Api>;
  send: SendModelRequest;
}): ModelClient {
  return {
    complete: async ({ model, session, context }, signal) => {
      const reasoning = toPiReasoningLevel(model.reasoning);
      const traced = createTracedStreamFn({
        base: dependencies.send,
        conversationPrivacy: model.privacy,
      });
      const stream = await traced(
        dependencies.resolveModel(model.id),
        context,
        {
          apiKey: await dependencies.apiKey(),
          sessionId: session,
          // Pi calls no reasoning `off`, and takes `undefined` to mean it.
          reasoning: reasoning === "off" ? undefined : reasoning,
          signal,
        },
      );
      return stream.result();
    },
  };
}
