import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import {
  createAssistantMessageEventStream,
  getInitialSystemMessage,
  getSystemMessageText,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import {
  streamSimple,
  type Api,
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
export interface ChatRequestTelemetry {
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
  if (message.stopReason === "error") {
    const providerError = createAssistantProviderError(message);
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
// any event records no timing.
function createResponseTiming(requestStartedAtMs: number): {
  observe: (event: AssistantMessageEvent) => void;
  attributes: () => TraceAttributes;
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
        return {};
      }
      return {
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

// A pi-ai event stream has one consumer. This relay is the consumer of the
// provider stream: it shows each event to `onEvent`, and calls `onEnd` with
// the final message before the relayed stream settles. The SDK ends the span
// when the relayed stream settles, so `onEnd` attributes reach the span.
function relayStream(
  source: AssistantMessageEventStream,
  onEvent: (event: AssistantMessageEvent) => void,
  onEnd: (message: AssistantMessage) => void,
): AssistantMessageEventStream {
  const relayed = createAssistantMessageEventStream();
  let ended = false;
  const end = (message: AssistantMessage) => {
    if (ended) return;
    ended = true;
    try {
      onEnd(message);
    } catch {
      // Diagnostic only.
    }
  };
  const finished = (async () => {
    try {
      for await (const event of source) {
        onEvent(event);
        if (event.type === "done") end(event.message);
        if (event.type === "error") end(event.error);
        relayed.push(event);
      }
    } finally {
      relayed.end();
    }
  })();
  // A provider can end its stream with `end(message)` and no terminal event.
  // Pass that message on only after every event is relayed, because the
  // relayed stream drops events pushed after it ends. pi-ai's `result()` does
  // not reject.
  void finished
    .then(() => source.result())
    .then(
      (message) => {
        end(message);
        relayed.end(message);
      },
      () => {},
    );
  return relayed;
}

/**
 * Adds Junior attributes to the `gen_ai.chat` span that the SDK's
 * `piAiIntegration` starts for each request. Register the result as the
 * provider's `streamSimple`: Pi calls it inside that span. Without the span,
 * for example when the build has no Sentry instrumentation, it calls `base`
 * unchanged.
 */
export function withChatSpanAttributes<TApi extends Api>(
  base: StreamFunction<TApi, SimpleStreamOptions>,
): StreamFunction<TApi, SimpleStreamOptions> {
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
    const requestStartedAtMs = Date.now();
    const responseTiming = createResponseTiming(requestStartedAtMs);
    const source = base(
      model,
      context,
      traceRequestPayload(span, traceResponseHeaders(span, options)),
    );
    return relayStream(source, responseTiming.observe, (message) => {
      span.setAttributes({
        ...buildEndAttributes(message),
        ...responseTiming.attributes(),
        ...telemetry?.endAttributes?.(message),
      });
    });
  };
}
