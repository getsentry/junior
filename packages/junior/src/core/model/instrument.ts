// Port of `createTracedStreamFn` in chat/pi/traced-stream.ts: each model
// request gets one `gen_ai.chat` span with the same name, op, and attributes as
// on the chat agent loop. Keep the two in step with the core-drift skill.
// Chat's compaction marker, caller end attributes, and log context attributes
// are not ported.
import { performance } from "node:perf_hooks";
import {
  createAssistantMessageEventStream,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import {
  normalizeFinishReason,
  toCanonicalInputMessage,
  toCanonicalOutputMessage,
  toGenAiMessagesTraceAttributes,
} from "@/core/model/instrument/messages";
import { providerErrorAttributes } from "@/core/model/instrument/provider-error";
import { serializeGenAiAttribute } from "@/core/model/instrument/redact";
import { requestPrefixAttributes } from "@/core/model/instrument/request-prefix";
import { routingAttributes } from "@/core/model/instrument/routing";
import { usageAttributes } from "@/core/model/instrument/usage";
import {
  openSpan,
  type OpenSpan,
  type SpanAttributeValue,
} from "@/core/telemetry";

/** Who can read a Conversation. A model request span records message content only for `public`. */
export type ConversationPrivacy = "public" | "private";

/** A pi-ai stream function, such as `streamSimple`. */
export type ModelStream = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

type Attributes = Record<string, SpanAttributeValue>;

// The span records the address of the model's endpoint, such as
// `ai-gateway.vercel.sh` and 443.
function serverAttributes(model: Model<Api>): Attributes {
  const url = new URL(model.baseUrl);
  return {
    "server.address": url.hostname,
    "server.port": Number(url.port || (url.protocol === "http:" ? 80 : 443)),
  };
}

// Compose only the OTel GenAI attributes that are knowable at span start
// (request-shape + system instructions). End-of-call attributes such as
// usage and finish reasons are set after the stream resolves.
function startAttributes(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  privacy: ConversationPrivacy,
): Attributes {
  const attributes: Attributes = {
    "gen_ai.operation.name": "chat",
    "gen_ai.provider.name": model.provider,
    "gen_ai.request.model": model.id,
    "gen_ai.request.stream": true,
    "gen_ai.output.type": "text",
    ...serverAttributes(model),
    ...(options?.temperature !== undefined
      ? { "gen_ai.request.temperature": options.temperature }
      : undefined),
    ...(options?.maxTokens !== undefined
      ? { "gen_ai.request.max_tokens": options.maxTokens }
      : undefined),
    ...(options?.reasoning
      ? { "gen_ai.request.reasoning.level": options.reasoning }
      : undefined),
    "app.conversation.privacy": privacy,
    ...toGenAiMessagesTraceAttributes("gen_ai.input", context.messages),
  };

  if (privacy === "public") {
    const inputMessages = serializeGenAiAttribute(
      context.messages.map(toCanonicalInputMessage),
    );
    if (inputMessages) {
      attributes["gen_ai.input.messages"] = inputMessages;
    }
  }

  if (context.systemPrompt) {
    if (privacy === "public") {
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
function endAttributes(
  message: AssistantMessage,
  privacy: ConversationPrivacy,
): Attributes {
  const attributes: Attributes = {
    ...toGenAiMessagesTraceAttributes("gen_ai.output", [message]),
  };

  if (privacy === "public") {
    const outputMessages = serializeGenAiAttribute([
      toCanonicalOutputMessage(message),
    ]);
    if (outputMessages) {
      attributes["gen_ai.output.messages"] = outputMessages;
    }
  }

  Object.assign(attributes, usageAttributes(message));
  // The 1h-retention part of the cache write. The 5m part is the rest of
  // `gen_ai.usage.cache_creation.input_tokens`. The key avoids "token",
  // because Sentry scrubs keys that contain it.
  if (message.usage.cacheWrite1h !== undefined) {
    attributes["app.ai.usage.cache_write_1h"] = message.usage.cacheWrite1h;
  }

  if (message.stopReason) {
    attributes["gen_ai.response.finish_reasons"] = [
      normalizeFinishReason(message.stopReason),
    ];
  }

  if (message.model) {
    attributes["gen_ai.response.model"] = message.model;
  }

  if (message.responseId) {
    attributes["gen_ai.response.id"] = message.responseId;
  }

  if (message.stopReason === "error") {
    const providerError = providerErrorAttributes(message);
    Object.assign(attributes, providerError.attributes);
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
function responseTiming(requestStartedAtMs: number): {
  observe: (event: AssistantMessageEvent) => void;
  attributes: () => Attributes;
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

// Wraps the Pi hooks of one request: `onResponse` records the Vercel edge
// request id and the event loop utilization since the span started,
// `onPayload` records the cache prefix hashes of the provider request body,
// and `onProviderStreamEvent` records how the request was routed. Each hook
// still calls the caller's hook, and `onPayload` never changes the payload.
function traceHooks(
  span: OpenSpan,
  options: SimpleStreamOptions | undefined,
): SimpleStreamOptions {
  const eventLoopStart = performance.eventLoopUtilization();
  const { onResponse, onPayload, onProviderStreamEvent } = options ?? {};
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
    onPayload: async (payload, model) => {
      const nextPayload = await onPayload?.(payload, model);
      span.setAttributes(requestPrefixAttributes(nextPayload ?? payload));
      return nextPayload;
    },
    onProviderStreamEvent: async (event, model) => {
      const attributes = routingAttributes(event);
      if (attributes) {
        span.setAttributes(attributes);
      }
      await onProviderStreamEvent?.(event, model);
    },
  };
}

// A pi-ai event stream has one consumer. This relay is the consumer of the
// provider stream: it shows each event to `onEvent` as the event arrives, then
// pushes the same event object to the stream that the caller reads. The
// relayed stream always ends when the provider stream ends. `finished`
// settles after the relay has seen the last event.
function relayStream(
  source: AssistantMessageEventStream,
  onEvent: (event: AssistantMessageEvent) => void,
): { stream: AssistantMessageEventStream; finished: Promise<void> } {
  const relayed = createAssistantMessageEventStream();
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
  // A provider can end its stream with `end(message)` and no terminal event.
  // Pass that message on only after every event is relayed, because the
  // relayed stream drops events pushed after it ends. pi-ai's `result()` does
  // not reject.
  void finished
    .then(() => source.result())
    .then(
      (message) => relayed.end(message),
      () => {},
    );
  return { stream: relayed, finished };
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * Adds one `gen_ai.chat` span to each request of a pi-ai stream function. The
 * span records the request shape, usage and cost, response timing, routing,
 * request-prefix hashes, and provider errors. It records message content only
 * when `privacy` is `public`, and only sizes, roles, and part types otherwise.
 * A failed reply or request sets the error status.
 */
export function instrumentModelStream(
  base: ModelStream,
  privacy: ConversationPrivacy,
): ModelStream {
  return async (model, context, options) => {
    const span = openSpan(
      `chat ${model.id}`,
      "gen_ai.chat",
      startAttributes(model, context, options, privacy),
    );

    try {
      const requestStartedAtMs = Date.now();
      const stream = await span.activate(() =>
        Promise.resolve(base(model, context, traceHooks(span, options))),
      );
      const timing = responseTiming(requestStartedAtMs);
      const relay = relayStream(stream, timing.observe);

      // End the span after the relay has seen every event, so the timing
      // attributes are complete even when the provider pushes all events at
      // once.
      relay.finished
        .then(() => stream.result())
        .then(
          (finalMessage: AssistantMessage) => {
            try {
              const attributes = {
                ...endAttributes(finalMessage, privacy),
                ...timing.attributes(),
              };
              for (const [key, value] of Object.entries(attributes)) {
                span.setAttribute(key, value);
              }
              if (finalMessage.stopReason === "error") {
                const summary = attributes["app.ai.provider_error.summary"];
                span.fail(
                  typeof summary === "string" ? summary : "LLM stream failed",
                );
              }
            } finally {
              span.end();
            }
          },
          (error: unknown) => {
            span.setAttributes(timing.attributes());
            span.setAttribute("error.type", errorType(error));
            span.fail("LLM stream failed");
            span.end();
          },
        )
        .catch(() => {
          // setAttribute is best-effort; suppress unexpected attribute-write
          // errors so they don't surface as unhandled promise rejections.
        });

      return relay.stream;
    } catch (error) {
      span.setAttribute("error.type", errorType(error));
      span.fail("LLM call failed");
      span.end();
      throw error;
    }
  };
}
