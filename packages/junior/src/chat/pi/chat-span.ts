import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import {
  getInitialSystemMessage,
  getSystemMessageText,
} from "@earendil-works/pi-ai";
import {
  streamSimple,
  type AssistantMessage,
  type Message,
  type SimpleStreamOptions,
  type StreamFunction,
} from "@earendil-works/pi-ai/compat";
import * as Sentry from "@/chat/sentry";
import type { AgentRequestStreamFn } from "@/chat/pi/agent-history";
import { getLogContextAttributesForSpan } from "@/chat/logging";
import { gatewayRoutingAttributes } from "@/chat/pi/gateway-routing-attributes";
import { requestPrefixAttributes } from "@/chat/pi/request-prefix-attributes";
import {
  getCurrentConversationPrivacy,
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
type PiAiOptions = NonNullable<Parameters<typeof Sentry.piAiIntegration>[0]>;
type PiAiSpanResult = Parameters<NonNullable<PiAiOptions["onSpanEnd"]>>[2];

/** Junior attributes for the `gen_ai.chat` spans of one model request. */
interface ChatRequestTelemetry {
  /** Attributes known before the request, such as `gen_ai.prompt.name`. */
  attributes?: TraceAttributes;
  /** Attributes from the final message. */
  endAttributes?: (message: AssistantMessage) => TraceAttributes | undefined;
}

// The provider stream reads the telemetry of the request that started it.
const chatRequestStorage = new AsyncLocalStorage<ChatRequestTelemetry>();
// `onSpanEnd` can run outside the async context of the request.
const endAttributesBySpan = new WeakMap<
  Sentry.Span,
  NonNullable<ChatRequestTelemetry["endAttributes"]>
>();

// The `sentry.origin` of the `gen_ai.chat` span that the SDK's
// `piAiIntegration` starts around each pi-ai request.
const PI_AI_SPAN_ORIGIN = "auto.ai.pi_ai";

/** Run one model request with the telemetry its `gen_ai.chat` span gets. */
export function withChatRequestTelemetry<T>(
  telemetry: ChatRequestTelemetry,
  callback: () => T,
): T {
  return chatRequestStorage.run(telemetry, callback);
}

/** Give each request of an agent loop stream function the same telemetry. */
export function withChatStreamTelemetry(
  telemetry: ChatRequestTelemetry,
  base: AgentRequestStreamFn = streamSimple,
): AgentRequestStreamFn {
  return (model, context, options) =>
    withChatRequestTelemetry(telemetry, () => base(model, context, options));
}

function activePiAiChatSpan(): Sentry.Span | undefined {
  const span = Sentry.getActiveSpan();
  if (!span) {
    return undefined;
  }
  const { attributes } = Sentry.spanToJSON(span);
  return attributes["sentry.origin"] === PI_AI_SPAN_ORIGIN ? span : undefined;
}

// The `piAiIntegration` span has the request, response, usage, and cost. These
// are the Junior facts that it does not have.
function buildStartAttributes(messages: Message[]): TraceAttributes {
  // Pi folds `Context.systemPrompt` and `Context.tools` into a leading system
  // message. Skip it, so the counts describe the conversation messages only.
  const system = getInitialSystemMessage(messages);
  const transcript = system ? messages.slice(1) : messages;
  return {
    ...getLogContextAttributesForSpan("gen_ai.chat"),
    "app.conversation.privacy": getCurrentConversationPrivacy() ?? "private",
    "gen_ai.conversation.compacted":
      hasCompactedConversationContext(transcript) || undefined,
    ...toGenAiMessagesTraceAttributes("gen_ai.input", transcript),
    "gen_ai.system_instructions.content_chars": system
      ? getSystemMessageText(system).length
      : undefined,
  };
}

function buildEndAttributes(message: AssistantMessage): TraceAttributes {
  const { input, cacheRead, cacheWrite, cacheWrite1h } = message.usage;
  const inputTokens = input + cacheRead + cacheWrite;
  const providerError =
    message.stopReason === "error"
      ? createAssistantProviderError(message)
      : undefined;
  return {
    ...toGenAiMessagesTraceAttributes("gen_ai.output", [message]),
    // The 1h-retention part of the cache write. The 5m part is the rest of
    // `gen_ai.usage.cache_creation.input_tokens`. The key avoids "token",
    // because Sentry scrubs keys that contain it.
    "app.ai.usage.cache_write_1h": cacheWrite1h,
    // Per-call ratio, because metric monitors cannot divide two sums. The
    // prompt cache detector reads it.
    "gen_ai.usage.cache_hit_ratio":
      inputTokens > 0 ? cacheRead / inputTokens : undefined,
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
  options: SimpleStreamOptions | undefined,
): SimpleStreamOptions {
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

// The SDK types the message structurally, because it does not depend on pi-ai.
function isAssistantMessage(
  message: PiAiSpanResult["response"],
): message is AssistantMessage {
  return message?.role === "assistant" && message.usage !== undefined;
}

/**
 * `piAiIntegration` hook that adds the Junior attributes of the final message
 * to the `gen_ai.chat` span of a pi-ai request, right before the span ends.
 */
export function setChatSpanEndAttributes(
  span: Sentry.Span,
  _call: unknown,
  { response }: PiAiSpanResult,
): void {
  if (!isAssistantMessage(response)) {
    return;
  }
  span.setAttributes({
    ...buildEndAttributes(response),
    ...endAttributesBySpan.get(span)?.(response),
  });
}

/**
 * Adds Junior attributes to the `gen_ai.chat` span that the SDK's
 * `piAiIntegration` starts for each request. Register the result as the
 * provider's `streamSimple`: Pi calls it inside that span. Without the span,
 * for example when the build has no Sentry instrumentation, it calls `base`
 * unchanged.
 */
export function withChatSpanAttributes(
  base: StreamFunction<"anthropic-messages", SimpleStreamOptions>,
): StreamFunction<"anthropic-messages", SimpleStreamOptions> {
  return (model, context, options) => {
    const span = activePiAiChatSpan();
    if (!span) {
      return base(model, context, options);
    }
    const telemetry = chatRequestStorage.getStore();
    span.setAttributes({
      ...buildStartAttributes(context.messages),
      ...telemetry?.attributes,
    });
    if (telemetry?.endAttributes) {
      endAttributesBySpan.set(span, telemetry.endAttributes);
    }
    return base(model, context, traceRequestHooks(span, options));
  };
}
