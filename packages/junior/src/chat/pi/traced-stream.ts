import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  streamSimple,
} from "@earendil-works/pi-ai";
import * as Sentry from "@/chat/sentry";
import {
  extractGenAiUsageAttributes,
  getLogContextAttributes,
  normalizeGenAiFinishReason,
  serializeGenAiAttribute,
} from "@/chat/logging";
import {
  GEN_AI_PROVIDER_NAME,
  GEN_AI_SERVER_ADDRESS,
  GEN_AI_SERVER_PORT,
} from "@/chat/pi/client";
import {
  type ConversationPrivacy,
  toGenAiMessageMetadata,
  toGenAiMessagesTraceAttributes,
  toGenAiTextMetadata,
} from "@/chat/conversation-privacy";

type GenAiAttributeMode = "content" | "metadata";
type TraceAttributeValue = string | number | boolean | string[];

function attributeModeForPrivacy(
  conversationPrivacy: ConversationPrivacy | undefined,
): GenAiAttributeMode {
  return conversationPrivacy === "public" ? "content" : "metadata";
}

// Compose only the OTel GenAI attributes that are knowable at span start
// (request-shape + system instructions). End-of-call attributes such as
// usage and finish reasons are set after the stream resolves.
function buildChatStartAttributes(
  model: Model<Api>,
  context: Context,
  mode: GenAiAttributeMode,
  conversationPrivacy: ConversationPrivacy | undefined,
): Record<string, TraceAttributeValue> {
  const attributes: Record<string, TraceAttributeValue> = {
    "gen_ai.operation.name": "chat",
    "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
    "gen_ai.request.model": model.id,
    "gen_ai.request.stream": true,
    "gen_ai.output.type": "text",
    "server.address": GEN_AI_SERVER_ADDRESS,
    "server.port": GEN_AI_SERVER_PORT,
    ...(conversationPrivacy
      ? { "app.conversation.privacy": conversationPrivacy }
      : {}),
    ...toGenAiMessagesTraceAttributes("app.ai.input", context.messages),
  };

  const inputMessages = serializeGenAiAttribute(
    mode === "metadata"
      ? context.messages.map(toGenAiMessageMetadata)
      : context.messages,
  );
  if (inputMessages) {
    attributes["gen_ai.input.messages"] = inputMessages;
  }

  if (context.systemPrompt) {
    const systemInstructions = serializeGenAiAttribute([
      mode === "metadata"
        ? toGenAiTextMetadata(context.systemPrompt)
        : { type: "text", content: context.systemPrompt },
    ]);
    if (systemInstructions) {
      attributes["gen_ai.system_instructions"] = systemInstructions;
    }
    attributes["app.ai.system_instructions.content_chars"] =
      context.systemPrompt.length;
  }

  return attributes;
}

// Composes post-stream attributes for the chat span.
function buildChatEndAttributes(
  message: AssistantMessage,
  mode: GenAiAttributeMode,
): Record<string, TraceAttributeValue> {
  const attributes: Record<string, TraceAttributeValue> = {
    ...toGenAiMessagesTraceAttributes("app.ai.output", [message]),
  };

  const outputMessages = serializeGenAiAttribute(
    mode === "metadata" ? [toGenAiMessageMetadata(message)] : [message],
  );
  if (outputMessages) {
    attributes["gen_ai.output.messages"] = outputMessages;
  }

  Object.assign(attributes, extractGenAiUsageAttributes(message));

  if (message.stopReason) {
    attributes["gen_ai.response.finish_reasons"] = [
      normalizeGenAiFinishReason(message.stopReason),
    ];
  }

  if (message.model) {
    attributes["gen_ai.response.model"] = message.model;
  }

  return attributes;
}

/**
 * Wraps pi-ai's `streamSimple` so each LLM call inside a pi-agent-core agent
 * loop produces its own `gen_ai.chat` Sentry span. The returned function is
 * passed to `new Agent({ streamFn: ... })` and runs once per loop iteration.
 *
 * The base argument exists so tests can inject a stub stream function.
 */
export function createTracedStreamFn(
  baseOrOptions:
    | StreamFn
    | {
        conversationPrivacy?: ConversationPrivacy;
        base?: StreamFn;
      } = streamSimple,
): StreamFn {
  const base =
    typeof baseOrOptions === "function"
      ? baseOrOptions
      : (baseOrOptions.base ?? streamSimple);
  const mode = attributeModeForPrivacy(
    typeof baseOrOptions === "function"
      ? undefined
      : baseOrOptions.conversationPrivacy,
  );
  const conversationPrivacy =
    typeof baseOrOptions === "function"
      ? undefined
      : baseOrOptions.conversationPrivacy;
  const effectivePrivacy = conversationPrivacy ?? "private";
  return async (model, context, options) => {
    const span = Sentry.startInactiveSpan({
      name: `chat ${model.id}`,
      op: "gen_ai.chat",
      attributes: {
        ...getLogContextAttributes(),
        ...buildChatStartAttributes(model, context, mode, effectivePrivacy),
      },
    });

    try {
      const stream = await Sentry.withActiveSpan(span, () =>
        Promise.resolve(base(model, context, options)),
      );

      stream
        .result()
        .then(
          (finalMessage) => {
            try {
              for (const [key, value] of Object.entries(
                buildChatEndAttributes(finalMessage, mode),
              )) {
                span.setAttribute(key, value);
              }
            } finally {
              span.end();
            }
          },
          () => {
            span.setStatus({ code: 2, message: "LLM stream failed" });
            span.end();
          },
        )
        .catch(() => {
          // setAttribute is best-effort; suppress unexpected attribute-write
          // errors so they don't surface as unhandled promise rejections.
        });

      return stream;
    } catch (error) {
      span.setStatus({ code: 2, message: "LLM call failed" });
      span.end();
      throw error;
    }
  };
}
