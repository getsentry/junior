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

type TraceAttributeValue = string | number | boolean | string[];
type TraceAttributes = Record<string, TraceAttributeValue>;

/** Junior attributes for the `gen_ai.chat` spans of one model request. */
interface ChatRequestTelemetry {
  /** Attributes known before the request, such as `gen_ai.prompt.name`. */
  attributes?: TraceAttributes;
  /** Attributes from the final message. */
  endAttributes?: (message: AssistantMessage) => TraceAttributes | undefined;
}

// The provider stream reads the telemetry of the request that started it.
const chatRequestStorage = new AsyncLocalStorage<ChatRequestTelemetry>();

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

// Pi folds `Context.systemPrompt` and `Context.tools` into a leading system
// message before it calls the provider. Split it off again, so the counts
// describe the conversation messages only.
function splitTranscript(messages: Message[]): {
  systemPrompt: string | undefined;
  messages: Message[];
} {
  const initial = getInitialSystemMessage(messages);
  return initial
    ? {
        systemPrompt: getSystemMessageText(initial),
        messages: messages.slice(1),
      }
    : { systemPrompt: undefined, messages };
}

// The `piAiIntegration` span has the request, response, usage, and cost. These
// are the Junior facts that it does not have.
function buildStartAttributes(messages: Message[]): TraceAttributes {
  const transcript = splitTranscript(messages);
  return {
    ...getLogContextAttributesForSpan("gen_ai.chat"),
    "app.conversation.privacy": getCurrentConversationPrivacy() ?? "private",
    ...(hasCompactedConversationContext(transcript.messages)
      ? { "gen_ai.conversation.compacted": true }
      : undefined),
    ...toGenAiMessagesTraceAttributes("gen_ai.input", transcript.messages),
    ...(transcript.systemPrompt
      ? {
          "gen_ai.system_instructions.content_chars":
            transcript.systemPrompt.length,
        }
      : undefined),
  };
}

function buildEndAttributes(message: AssistantMessage): TraceAttributes {
  const attributes: TraceAttributes = {
    ...toGenAiMessagesTraceAttributes("gen_ai.output", [message]),
  };
  // The 1h-retention part of the cache write. The 5m part is the rest of
  // `gen_ai.usage.cache_creation.input_tokens`. The key avoids "token",
  // because Sentry scrubs keys that contain it.
  if (message.usage.cacheWrite1h !== undefined) {
    attributes["app.ai.usage.cache_write_1h"] = message.usage.cacheWrite1h;
  }
  // Per-call ratio, because metric monitors cannot divide two sums. The
  // prompt cache detector reads it.
  const { input, cacheRead, cacheWrite } = message.usage;
  const inputTokens = input + cacheRead + cacheWrite;
  if (inputTokens > 0) {
    attributes["gen_ai.usage.cache_hit_ratio"] = cacheRead / inputTokens;
  }
  if (message.stopReason === "error") {
    const providerError = createAssistantProviderError(message);
    Object.assign(attributes, getProviderErrorAttributes(providerError));
    attributes["error.type"] = providerError.kind;
  }
  return attributes;
}

// Wraps `onResponse`, which Pi calls when the response headers arrive. It
// records the Vercel edge request id (its POP chain) and the event loop
// utilization since the request started. High utilization means a busy event
// loop could have delayed the request on Junior's side.
function traceResponseHeaders(
  span: Sentry.Span,
  options: SimpleStreamOptions | undefined,
): SimpleStreamOptions {
  const eventLoopStart = performance.eventLoopUtilization();
  const onResponse = options?.onResponse;
  return {
    ...options,
    onResponse: async (response, model) => {
      try {
        const vercelId = response.headers["x-vercel-id"];
        if (vercelId) {
          span.setAttribute("app.ai.gateway.vercel_id", vercelId);
        }
        const { utilization } =
          performance.eventLoopUtilization(eventLoopStart);
        span.setAttribute(
          "app.ai.event_loop.utilization",
          Math.round(utilization * 1000) / 1000,
        );
      } catch {
        // Diagnostic only.
      }
      await onResponse?.(response, model);
    },
  };
}

// Wraps `onPayload`, which Pi calls with the provider request body before it
// sends it. It records the cache prefix hashes of that body. It returns the
// result of the wrapped hook, so it never changes the payload itself.
function traceRequestPayload(
  span: Sentry.Span,
  options: SimpleStreamOptions,
): SimpleStreamOptions {
  const onPayload = options.onPayload;
  return {
    ...options,
    onPayload: async (payload, model) => {
      const nextPayload = await onPayload?.(payload, model);
      span.setAttributes(requestPrefixAttributes(nextPayload ?? payload));
      return nextPayload;
    },
  };
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
    const stream = base(
      model,
      context,
      traceRequestPayload(span, traceResponseHeaders(span, options)),
    );
    // The SDK ends the span in a `result()` callback that it adds after this
    // function returns, so this callback runs first.
    void stream.result().then((message) => {
      span.setAttributes({
        ...buildEndAttributes(message),
        ...telemetry?.endAttributes?.(message),
      });
    });
    return stream;
  };
}
