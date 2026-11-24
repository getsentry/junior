import { performance } from "node:perf_hooks";
import {
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  streamSimple,
} from "@earendil-works/pi-ai/compat";
import * as Sentry from "@/chat/sentry";
import type { AgentRequestStreamFn } from "@/chat/pi/agent-history";
import {
  extractGenAiUsageAttributes,
  getLogContextAttributesForSpan,
  normalizeGenAiFinishReason,
  serializeGenAiAttribute,
} from "@/chat/logging";
import { GEN_AI_PROVIDER_NAME, GEN_AI_SERVER_ADDRESS } from "@/chat/pi/client";
import { gatewayRoutingAttributes } from "@/chat/pi/gateway-routing-attributes";
import { requestPrefixAttributes } from "@/chat/pi/request-prefix-attributes";
import {
  type ConversationPrivacy,
  toCanonicalInputMessage,
  toCanonicalOutputMessage,
  toGenAiMessagesTraceAttributes,
} from "@/chat/conversation-privacy";
import { hasCompactedConversationContext } from "@/chat/services/context-compaction-marker";
import {
  createAssistantProviderError,
  getProviderErrorAttributes,
} from "@/chat/services/provider-error";

// Sentry drops attributes whose value is undefined.
type TraceAttributes = Record<
  string,
  string | number | boolean | string[] | undefined
>;

// Compose only the OTel GenAI attributes that are knowable at span start
// (request-shape + system instructions). End-of-call attributes such as
// usage and finish reasons are set after the stream resolves.
function buildChatStartAttributes(
  model: Model<Api>,
  context: Context,
  options: Parameters<AgentRequestStreamFn>[2],
  conversationPrivacy: ConversationPrivacy,
  promptName: string | undefined,
): TraceAttributes {
  const recordContent = conversationPrivacy === "public";
  return {
    "gen_ai.operation.name": "chat",
    "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
    "gen_ai.request.model": model.id,
    "gen_ai.prompt.name": promptName,
    "server.address": GEN_AI_SERVER_ADDRESS,
    "gen_ai.request.temperature": options?.temperature,
    "gen_ai.request.max_tokens": options?.maxTokens,
    "gen_ai.request.reasoning.level": options?.reasoning,
    "gen_ai.conversation.compacted":
      hasCompactedConversationContext(context.messages) || undefined,
    "app.conversation.privacy": conversationPrivacy,
    ...toGenAiMessagesTraceAttributes("gen_ai.input", context.messages),
    "gen_ai.input.messages": recordContent
      ? serializeGenAiAttribute(context.messages.map(toCanonicalInputMessage))
      : undefined,
    "gen_ai.system_instructions":
      recordContent && context.systemPrompt
        ? serializeGenAiAttribute([
            { type: "text", content: context.systemPrompt },
          ])
        : undefined,
    "gen_ai.system_instructions.content_chars": context.systemPrompt?.length,
  };
}

// Composes post-stream attributes for the chat span.
function buildChatEndAttributes(
  message: AssistantMessage,
  conversationPrivacy: ConversationPrivacy,
): TraceAttributes {
  const providerError =
    message.stopReason === "error"
      ? createAssistantProviderError(message)
      : undefined;
  return {
    ...toGenAiMessagesTraceAttributes("gen_ai.output", [message]),
    "gen_ai.output.messages":
      conversationPrivacy === "public"
        ? serializeGenAiAttribute([toCanonicalOutputMessage(message)])
        : undefined,
    ...extractGenAiUsageAttributes(message),
    // The 1h-retention part of the cache write. The 5m part is the rest of
    // `gen_ai.usage.cache_creation.input_tokens`. The key avoids "token",
    // because Sentry scrubs keys that contain it.
    "app.ai.usage.cache_write_1h": message.usage.cacheWrite1h,
    "gen_ai.response.finish_reasons": [
      normalizeGenAiFinishReason(message.stopReason),
    ],
    "gen_ai.response.model": message.model,
    "gen_ai.response.id": message.responseId,
    ...(providerError && {
      ...getProviderErrorAttributes(providerError),
      "error.type": providerError.kind,
    }),
  };
}

// Wraps the Pi hooks of one request:
// - `onPayload` gets the provider request body. It records the cache prefix
//   hashes and returns the wrapped hook's result, so the body is unchanged.
// - `onResponse` gets the response headers. It records the Vercel edge request
//   id (its POP chain) and the event loop utilization since the request
//   started. High utilization means Junior's busy event loop could have
//   delayed the request.
// - `onProviderStreamEvent` gets each raw stream event. It records how AI
//   Gateway routed the request.
function traceRequestHooks(
  span: Sentry.Span,
  options: Parameters<AgentRequestStreamFn>[2],
): Parameters<AgentRequestStreamFn>[2] {
  const eventLoopStart = performance.eventLoopUtilization();
  return {
    ...options,
    onPayload: async (payload, model) => {
      const nextPayload = await options?.onPayload?.(payload, model);
      span.setAttributes(requestPrefixAttributes(nextPayload ?? payload));
      return nextPayload;
    },
    onResponse: async (response, model) => {
      const { utilization } = performance.eventLoopUtilization(eventLoopStart);
      span.setAttributes({
        "app.ai.gateway.vercel_id": response.headers["x-vercel-id"],
        "app.ai.event_loop.utilization": Math.round(utilization * 1000) / 1000,
      });
      await options?.onResponse?.(response, model);
    },
    onProviderStreamEvent: async (event, model) => {
      span.setAttributes(gatewayRoutingAttributes(event) ?? {});
      await options?.onProviderStreamEvent?.(event, model);
    },
  };
}

/**
 * Wraps pi-ai's `streamSimple` so each LLM call inside a pi-agent-core agent
 * loop produces its own `gen_ai.chat` Sentry span. The returned function is
 * passed to `new Agent({ streamFn: ... })` and runs once per loop iteration.
 *
 * `base` replaces `streamSimple`, for example in tests. `promptName` names a
 * request that is not an agent loop call, such as a context summary.
 * `endAttributes` adds caller attributes from the final message.
 */
export function createTracedStreamFn({
  base = streamSimple,
  conversationPrivacy = "private",
  endAttributes,
  promptName,
}: {
  base?: AgentRequestStreamFn | undefined;
  conversationPrivacy?: ConversationPrivacy | undefined;
  endAttributes?: (message: AssistantMessage) => TraceAttributes | undefined;
  promptName?: string | undefined;
} = {}): AgentRequestStreamFn {
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
          conversationPrivacy,
          promptName,
        ),
      },
    });

    try {
      const stream = await Sentry.withActiveSpan(span, () =>
        base(model, context, traceRequestHooks(span, options)),
      );
      // pi-ai's `result()` settles when the provider stream ends.
      stream
        .result()
        .then(
          (message) => {
            try {
              const attributes = {
                ...buildChatEndAttributes(message, conversationPrivacy),
                ...endAttributes?.(message),
              };
              span.setAttributes(attributes);
              if (message.stopReason === "error") {
                const summary = attributes["app.ai.provider_error.summary"];
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
            span.setAttribute(
              "error.type",
              error instanceof Error ? error.name : typeof error,
            );
            span.setStatus({ code: 2, message: "LLM stream failed" });
            span.end();
          },
        )
        .catch(() => {
          // Attributes are best-effort. A failed write must not surface as an
          // unhandled rejection.
        });
      return stream;
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
