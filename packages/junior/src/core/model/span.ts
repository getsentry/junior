// The attributes of a `gen_ai.chat` span, with the names of main's spans so
// existing queries keep working. A private Conversation records only message
// metadata, never content.
import type {
  AssistantMessage,
  AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import {
  toCanonicalInputMessage,
  toCanonicalOutputMessage,
  toGenAiMessagesTraceAttributes,
  type ConversationPrivacy,
} from "@/chat/conversation-privacy";
import {
  extractGenAiUsageAttributes,
  normalizeGenAiFinishReason,
  serializeGenAiAttribute,
} from "@/chat/logging";
import type { ModelRequest } from "@/core/model/client";
import type { SpanAttributes } from "@/core/telemetry";

// Core sends every model request through AI Gateway.
const GATEWAY_ATTRIBUTES = {
  "gen_ai.provider.name": "vercel-ai-gateway",
  "server.address": "ai-gateway.vercel.sh",
  "server.port": 443,
} as const;

// Stream events that carry no model content. A content block's start event
// counts as content: it arrives when the model starts that block.
const NON_CONTENT_EVENT_TYPES = new Set(["start", "done", "error"]);

/** The attributes that a request has before it is sent. */
export function chatStartAttributes({
  model,
  session,
  context,
}: ModelRequest): SpanAttributes {
  const content = model.privacy === "public";
  return {
    ...GATEWAY_ATTRIBUTES,
    "gen_ai.operation.name": "chat",
    "gen_ai.request.model": model.id,
    "gen_ai.request.stream": true,
    "gen_ai.output.type": "text",
    "gen_ai.conversation.id": session,
    ...(model.reasoning !== "none"
      ? { "gen_ai.request.reasoning.level": model.reasoning }
      : undefined),
    "app.conversation.privacy": model.privacy,
    ...toGenAiMessagesTraceAttributes("gen_ai.input", context.messages),
    ...(content
      ? {
          "gen_ai.input.messages": serializeGenAiAttribute(
            context.messages.map(toCanonicalInputMessage),
          ),
        }
      : undefined),
    ...(context.systemPrompt
      ? {
          "gen_ai.system_instructions.content_chars":
            context.systemPrompt.length,
          ...(content
            ? {
                "gen_ai.system_instructions": serializeGenAiAttribute([
                  { type: "text", content: context.systemPrompt },
                ]),
              }
            : undefined),
        }
      : undefined),
  };
}

/** The attributes that the final reply of a request gives. */
export function chatEndAttributes(
  message: AssistantMessage,
  privacy: ConversationPrivacy,
): SpanAttributes {
  return {
    ...toGenAiMessagesTraceAttributes("gen_ai.output", [message]),
    ...(privacy === "public"
      ? {
          "gen_ai.output.messages": serializeGenAiAttribute([
            toCanonicalOutputMessage(message),
          ]),
        }
      : undefined),
    ...extractGenAiUsageAttributes(message),
    // The 1h-retention part of the cache write. The key avoids "token",
    // because Sentry scrubs keys that contain it.
    "app.ai.usage.cache_write_1h": message.usage.cacheWrite1h,
    "gen_ai.response.finish_reasons": [
      normalizeGenAiFinishReason(message.stopReason),
    ],
    "gen_ai.response.model": message.model,
    "gen_ai.response.id": message.responseId,
  };
}

/**
 * Records when the first stream event and the first content event of a
 * response arrive. A request that fails before any event records
 * `gen_ai.response.streaming: false` and no timing.
 */
export function responseTiming(requestStartedAtMs: number): {
  observe: (event: AssistantMessageEvent) => void;
  attributes: () => SpanAttributes;
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
    attributes: () =>
      firstByteAtMs === undefined
        ? { "gen_ai.response.streaming": false }
        : {
            "gen_ai.response.streaming": true,
            "app.ai.time_to_first_byte_ms": firstByteAtMs - requestStartedAtMs,
            ...(firstToken
              ? {
                  "gen_ai.response.time_to_first_chunk":
                    (firstToken.receivedAtMs - requestStartedAtMs) / 1000,
                  "app.ai.first_token_type": firstToken.type,
                }
              : undefined),
          },
  };
}
