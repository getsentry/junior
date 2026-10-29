import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import {
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  streamSimple,
} from "@earendil-works/pi-ai/compat";
import * as Sentry from "@/chat/sentry";
import {
  extractGenAiUsageAttributes,
  getLogContextAttributesForSpan,
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
  toCanonicalInputMessage,
  toCanonicalOutputMessage,
  toGenAiMessagesTraceAttributes,
} from "@/chat/conversation-privacy";
import { hasCompactedConversationContext } from "@/chat/services/context-compaction-marker";
import {
  createProviderError,
  getProviderErrorAttributes,
} from "@/chat/services/provider-error";

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
  options: Parameters<StreamFn>[2],
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
    ...(options?.temperature !== undefined
      ? { "gen_ai.request.temperature": options.temperature }
      : undefined),
    ...(options?.maxTokens !== undefined
      ? { "gen_ai.request.max_tokens": options.maxTokens }
      : undefined),
    ...(options?.reasoning
      ? { "gen_ai.request.reasoning.level": options.reasoning }
      : undefined),
    ...(hasCompactedConversationContext(context.messages)
      ? { "gen_ai.conversation.compacted": true }
      : undefined),
    ...(conversationPrivacy
      ? { "app.conversation.privacy": conversationPrivacy }
      : undefined),
    ...toGenAiMessagesTraceAttributes("gen_ai.input", context.messages),
  };

  if (mode === "content") {
    const inputMessages = serializeGenAiAttribute(
      context.messages.map(toCanonicalInputMessage),
    );
    if (inputMessages) {
      attributes["gen_ai.input.messages"] = inputMessages;
    }
  }

  if (context.systemPrompt) {
    if (mode === "content") {
      const systemInstructions = serializeGenAiAttribute([
        { type: "text", content: context.systemPrompt },
      ]);
      if (systemInstructions) {
        attributes["gen_ai.system_instructions"] = systemInstructions;
      }
    }
    attributes["gen_ai.system_instructions.content_chars"] =
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
    ...toGenAiMessagesTraceAttributes("gen_ai.output", [message]),
  };

  if (mode === "content") {
    const outputMessages = serializeGenAiAttribute([
      toCanonicalOutputMessage(message),
    ]);
    if (outputMessages) {
      attributes["gen_ai.output.messages"] = outputMessages;
    }
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

  if (message.stopReason === "error") {
    const providerError = createProviderError(message.errorMessage ?? "");
    Object.assign(attributes, getProviderErrorAttributes(providerError));
    attributes["error.type"] = providerError.kind;
  }

  return attributes;
}

// Events that do not carry model content. Pi pushes `start` when the HTTP
// response resolves. Content block events (`*_start`, `*_delta`, `*_end`) all
// count as content: a block start arrives when the model starts that block,
// and a tool call start already carries the tool name.
const NON_CONTENT_EVENT_TYPES = new Set(["start", "done", "error"]);

// Records when the first event and the first content event arrive. A terminal
// `error` event is not a response chunk, so a call that fails or aborts before
// any event records `streaming: false` and no timing.
function createResponseTiming(requestStartedAtMs: number): {
  observe: (event: AssistantMessageEvent) => void;
  attributes: () => Record<string, TraceAttributeValue>;
} {
  let firstByteAtMs: number | undefined;
  let firstToken: { type: string; receivedAtMs: number } | undefined;
  return {
    observe: (event) => {
      if (firstByteAtMs === undefined && event.type !== "error") {
        firstByteAtMs = Date.now();
      }
      if (!firstToken && !NON_CONTENT_EVENT_TYPES.has(event.type)) {
        firstToken = { type: event.type, receivedAtMs: Date.now() };
      }
    },
    attributes: () => {
      if (firstByteAtMs === undefined) {
        return { "gen_ai.response.streaming": false };
      }
      return {
        "gen_ai.response.streaming": true,
        "app.ai.time_to_first_byte_ms": firstByteAtMs - requestStartedAtMs,
        ...(firstToken
          ? {
              "gen_ai.response.time_to_first_chunk":
                (firstToken.receivedAtMs - requestStartedAtMs) / 1000,
              "app.ai.first_token_type": firstToken.type,
            }
          : undefined),
      };
    },
  };
}

// A pi-ai event stream has one consumer. This relay is the consumer of the
// provider stream: it shows each event to `onEvent` as the event arrives, then
// pushes the same event object to the stream that the agent loop reads. The
// relayed stream always ends when the provider stream ends. `finished`
// settles after the relay has seen the last event.
function relayStream(
  source: AssistantMessageEventStream,
  onEvent: (event: AssistantMessageEvent) => void,
): { stream: AssistantMessageEventStream; finished: Promise<void> } {
  const relayed = createAssistantMessageEventStream();
  // `result()` returns the provider stream's own promise, so the final
  // message, and a rejection if one occurs, reach the agent loop unchanged.
  relayed.result = () => source.result();
  const finished = (async () => {
    try {
      for await (const event of source) {
        onEvent(event);
        relayed.push(event);
      }
    } finally {
      relayed.end();
    }
  })();
  return { stream: relayed, finished };
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
        ...getLogContextAttributesForSpan("gen_ai.chat"),
        ...buildChatStartAttributes(
          model,
          context,
          options,
          mode,
          effectivePrivacy,
        ),
      },
    });

    try {
      const requestStartedAtMs = Date.now();
      const stream = await Sentry.withActiveSpan(span, () =>
        Promise.resolve(base(model, context, options)),
      );
      const responseTiming = createResponseTiming(requestStartedAtMs);
      const relay = relayStream(stream, responseTiming.observe);

      // End the span after the relay has seen every event, so the timing
      // attributes are complete even when the provider pushes all events at
      // once.
      relay.finished
        .then(() => stream.result())
        .then(
          (finalMessage: AssistantMessage) => {
            try {
              const endAttributes = {
                ...buildChatEndAttributes(finalMessage, mode),
                ...responseTiming.attributes(),
              };
              for (const [key, value] of Object.entries(endAttributes)) {
                span.setAttribute(key, value);
              }
              if (finalMessage.stopReason === "error") {
                const summary = endAttributes["app.ai.provider_error.summary"];
                span.setStatus({
                  code: 2,
                  message:
                    typeof summary === "string" ? summary : "LLM stream failed",
                });
              }
            } finally {
              span.end();
            }
          },
          (error: unknown) => {
            span.setAttributes(responseTiming.attributes());
            span.setAttribute(
              "error.type",
              error instanceof Error ? error.name : typeof error,
            );
            span.setStatus({ code: 2, message: "LLM stream failed" });
            span.end();
          },
        )
        .catch(() => {
          // setAttribute is best-effort; suppress unexpected attribute-write
          // errors so they don't surface as unhandled promise rejections.
        });

      return relay.stream;
    } catch (error) {
      span.setAttribute(
        "error.type",
        error instanceof Error ? error.name : typeof error,
      );
      span.setStatus({ code: 2, message: "LLM call failed" });
      span.end();
      throw error;
    }
  };
}
