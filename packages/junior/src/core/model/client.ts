// The model calls of core. The host builds one client from its credentials
// and model catalog, and passes it to the Turn engine. Each request carries
// its own settings, so one client serves every Turn.
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  tracedStream,
  type ConversationPrivacy,
  type ModelStream,
} from "@/core/model/span";

/** How much the model reasons before it replies. */
export type TurnReasoningLevel = "none" | "low" | "medium" | "high" | "xhigh";

// Pi calls no reasoning `off`, and takes `undefined` to mean it.
function thinkingLevel(level: TurnReasoningLevel): ThinkingLevel | undefined {
  return level === "none" ? undefined : level;
}

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
 * credential can rotate between requests. `stream` sends the request, such
 * as pi-ai's `streamSimple`.
 */
export function modelClient(dependencies: {
  apiKey: () => Promise<string>;
  resolveModel: (id: string) => Model<Api>;
  stream: ModelStream;
}): ModelClient {
  return {
    complete: async ({ model, session, context }, signal) => {
      const stream = await tracedStream(dependencies.stream, model.privacy)(
        dependencies.resolveModel(model.id),
        context,
        {
          apiKey: await dependencies.apiKey(),
          sessionId: session,
          reasoning: thinkingLevel(model.reasoning),
          signal,
        },
      );
      return stream.result();
    },
  };
}
