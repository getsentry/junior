import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  streamSimple,
} from "@mariozechner/pi-ai";
import * as Sentry from "@/chat/sentry";
import {
  extractGenAiUsageAttributes,
  getLogContextAttributes,
  serializeGenAiAttribute,
} from "@/chat/logging";
import { GEN_AI_PROVIDER_NAME } from "@/chat/pi/client";
import { TURN_CONTEXT_TAG } from "@/chat/turn-context-tag";

const TURN_CONTEXT_OPEN = `<${TURN_CONTEXT_TAG}>`;
const CURRENT_INSTRUCTION_RE =
  /<current-instruction[^>]*>\n?([\s\S]*?)\n?<\/current-instruction>/;
const WRAPPER_BLOCKS_RE =
  /<(?:thread-background|session-context|turn-context)>[\s\S]*?<\/(?:thread-background|session-context|turn-context)>\n*/g;

/** Extract the user's actual instruction from a `buildUserTurnText` output. */
function extractUserInstruction(text: string): string {
  const match = CURRENT_INSTRUCTION_RE.exec(text);
  if (match) {
    return match[1].trim();
  }
  return text.replace(WRAPPER_BLOCKS_RE, "").trim();
}

/**
 * Clean user messages for the observable `gen_ai.input.messages` attribute:
 * 1. Drop `<runtime-turn-context>` content parts entirely (volatile runtime metadata).
 * 2. Unwrap `<current-instruction>` / strip `<thread-background>` etc. from text
 *    so only the actual user instruction remains.
 */
function cleanUserMessagesForObservability(messages: unknown[]): unknown[] {
  return messages.map((msg) => {
    const record = msg as Record<string, unknown> | null;
    if (!record || record.role !== "user") {
      return msg;
    }

    const content = record.content;
    if (!Array.isArray(content)) {
      return msg;
    }

    let changed = false;
    const cleaned = content
      .filter((part) => {
        if (
          part &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text"
        ) {
          const text = (part as { text?: unknown }).text;
          if (typeof text === "string" && text.startsWith(TURN_CONTEXT_OPEN)) {
            changed = true;
            return false;
          }
        }
        return true;
      })
      .map((part) => {
        if (
          part &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text"
        ) {
          const text = (part as { text?: unknown }).text;
          if (typeof text === "string" && CURRENT_INSTRUCTION_RE.test(text)) {
            changed = true;
            return { ...part, text: extractUserInstruction(text) };
          }
        }
        return part;
      });

    return changed ? { ...record, content: cleaned } : msg;
  });
}

// Compose only the OTel GenAI attributes that are knowable at span start
// (request-shape + system instructions). End-of-call attributes such as
// usage and finish reasons are set after the stream resolves.
function buildChatStartAttributes(
  model: Model<Api>,
  context: Context,
): Record<string, string> {
  const attributes: Record<string, string> = {
    "gen_ai.operation.name": "chat",
    "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
    "gen_ai.request.model": model.id,
  };

  const observableMessages = cleanUserMessagesForObservability(
    context.messages,
  );
  const inputMessages = serializeGenAiAttribute(observableMessages);
  if (inputMessages) {
    attributes["gen_ai.input.messages"] = inputMessages;
  }

  if (context.systemPrompt) {
    const systemInstructions = serializeGenAiAttribute([
      { type: "text", content: context.systemPrompt },
    ]);
    if (systemInstructions) {
      attributes["gen_ai.system_instructions"] = systemInstructions;
    }
  }

  return attributes;
}

// Composes post-stream attributes for the chat span.
// Known gap: `gen_ai.response.finish_reasons` emits pi-ai's raw StopReason
// values (e.g. "toolUse", "aborted") instead of the OTel canonical set
// ("tool_use", "max_tokens"). Tracked separately, out of scope here.
function buildChatEndAttributes(
  message: AssistantMessage,
): Record<string, string | string[] | number> {
  const attributes: Record<string, string | string[] | number> = {};

  const outputMessages = serializeGenAiAttribute([message]);
  if (outputMessages) {
    attributes["gen_ai.output.messages"] = outputMessages;
  }

  Object.assign(attributes, extractGenAiUsageAttributes(message));

  if (message.stopReason) {
    attributes["gen_ai.response.finish_reasons"] = [message.stopReason];
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
export function createTracedStreamFn(base: StreamFn = streamSimple): StreamFn {
  return async (model, context, options) => {
    const span = Sentry.startInactiveSpan({
      name: `chat ${model.id}`,
      op: "gen_ai.chat",
      attributes: {
        ...getLogContextAttributes(),
        ...buildChatStartAttributes(model, context),
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
                buildChatEndAttributes(finalMessage),
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
