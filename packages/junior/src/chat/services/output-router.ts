import type { AssistantMessage } from "@earendil-works/pi-ai";
import { z } from "zod";
import { NO_REPLY_MARKER, isNoReplyMarker } from "@/chat/no-reply";
import {
  logInfo,
  logWarn,
  setSpanAttributes,
  withSpan,
  type LogContext,
} from "@/chat/logging";
import { JUNIOR_PERSONALITY } from "@/chat/prompt";
import {
  decideReply,
  sanitizeAssistantText,
} from "@/chat/services/assistant-reply";

/** Soft length target for visible replies. */
export const OUTPUT_REPLY_SOFT_MAX_CHARS = 800;
/** Absolute max for a rewritten visible reply. */
export const OUTPUT_REPLY_HARD_MAX_CHARS = 1_200;

const OUTPUT_ROUTER_MAX_TOKENS = 1_200;
const OUTPUT_ROUTER_PROMPT_MAX_CHARS = 12_000;

/**
 * Model output is intentionally small:
 * - text=null → no visible reply
 * - text=string → that string is the visible reply
 */
const preparedReplySchema = z
  .object({
    text: z.string().nullable(),
    reason: z.string().min(1),
  })
  .strict();

export type PreparedAssistantReply =
  | {
      kind: "silent";
      costUsd?: number;
      reason: string;
    }
  | {
      kind: "reply";
      costUsd?: number;
      reason: string;
      /** Visible reply text. May differ from the original agent text. */
      text: string;
    };

type CompleteObject = (args: {
  modelId: string;
  schema: typeof preparedReplySchema;
  maxTokens: number;
  metadata: Record<string, string>;
  prompt: string;
  thinkingLevel?: "low" | "medium" | "high" | "xhigh";
  system: string;
  temperature: number;
  promptName?: string;
}) => Promise<{ costUsd?: number; object: unknown }>;

/**
 * Prompt shape follows current lab guidance:
 * - put the task and rules first
 * - keep rules short, specific, and direct
 * - put the message body in the user turn, separate from instructions
 * - let the JSON schema own the output shape; do not restate it at length
 * - include SOUL personality so rewrites keep the bot voice
 *
 * Refs: OpenAI prompt engineering + structured outputs; Anthropic clear/direct.
 */
function buildSystemPrompt(personality: string = JUNIOR_PERSONALITY): string {
  return [
    "Edit one assistant message into the final reply the user will see.",
    "You receive only that message. No other conversation context.",
    "Fields: text is the reply or null. reason is one short sentence.",
    "",
    "Rules:",
    `- Set text to null when there is nothing to show the user: empty text, only ${NO_REPLY_MARKER}, or internal work notes that are not an answer.`,
    `- If the message ends with ${NO_REPLY_MARKER} and the rest is only internal work status, set text to null. Do not keep those notes.`,
    `- If the message answers the user, keep it as a reply even when it contains ${NO_REPLY_MARKER}.`,
    `- If ${NO_REPLY_MARKER} is only a trailing tag after a real answer, keep the answer and drop the tag.`,
    `- If the answer explains ${NO_REPLY_MARKER}, keep the marker text the user needs.`,
    `- Keep short clear replies as-is (about ${OUTPUT_REPLY_SOFT_MAX_CHARS} characters or less).`,
    "- If the reply is longer than that, shorten it to 1-5 short sentences. Keep the answer, key facts, links, and next steps. Do not add facts.",
    "- Do not add a preface or commentary about editing.",
    "- These rules win over personality when they conflict.",
    "",
    "Personality",
    "Match this voice and tone when you keep or rewrite text:",
    personality.trim(),
  ].join("\n");
}

function buildUserPrompt(text: string): string {
  const body =
    text.length <= OUTPUT_ROUTER_PROMPT_MAX_CHARS
      ? text
      : `${text.slice(0, OUTPUT_ROUTER_PROMPT_MAX_CHARS)}\n…[truncated]…`;
  // Keep instructions in the system prompt. Put only the message body here.
  return ["Message:", '"""', body, '"""'].join("\n");
}

function capVisibleText(text: string): string {
  if (text.length <= OUTPUT_REPLY_HARD_MAX_CHARS) {
    return text;
  }
  return `${text.slice(0, OUTPUT_REPLY_HARD_MAX_CHARS - 1).trimEnd()}…`;
}

function silent(reason: string, costUsd?: number): PreparedAssistantReply {
  return {
    kind: "silent",
    reason,
    ...(costUsd !== undefined ? { costUsd } : undefined),
  };
}

function reply(
  text: string,
  reason: string,
  costUsd?: number,
): PreparedAssistantReply {
  return {
    kind: "reply",
    text,
    reason,
    ...(costUsd !== undefined ? { costUsd } : undefined),
  };
}

/**
 * Cheap local checks before calling the model.
 * Only exact silence stays local. Mixed marker text needs the model.
 */
export function prepareAssistantReplyLocal(
  text: string,
): PreparedAssistantReply | null {
  const trimmed = sanitizeAssistantText(text);
  if (!trimmed) {
    return silent("empty");
  }
  if (isNoReplyMarker(trimmed)) {
    return silent("no_reply");
  }
  return null;
}

function finalizeModelResult(
  object: unknown,
  originalText: string,
  costUsd?: number,
): PreparedAssistantReply {
  const parsed = preparedReplySchema.parse(object);
  const reason = parsed.reason.trim() || "prepared";

  if (parsed.text === null) {
    return silent(reason, costUsd);
  }

  const text = sanitizeAssistantText(parsed.text);
  if (!text) {
    // Model returned blank text. Keep the original visible reply.
    return reply(originalText, `empty_model_text:${reason}`, costUsd);
  }
  // Exact marker-only output is silence. Otherwise keep the model text,
  // including answers that mention or explain the marker.
  if (isNoReplyMarker(text)) {
    return silent(`model_no_reply:${reason}`, costUsd);
  }
  return reply(capVisibleText(text), reason, costUsd);
}

/**
 * Prepare the visible reply for one assistant message.
 * Does not change the original agent message text.
 */
export async function prepareAssistantReply(args: {
  completeObject: CompleteObject;
  context?: {
    conversationId?: string;
    runId?: string;
  };
  fastModelId: string;
  text: string;
}): Promise<PreparedAssistantReply> {
  const originalText = sanitizeAssistantText(args.text);
  const local = prepareAssistantReplyLocal(originalText);
  if (local) {
    return local;
  }

  const logContext: LogContext = {
    messageConversationId: args.context?.conversationId,
    runId: args.context?.runId,
    modelId: args.fastModelId,
  };

  return withSpan(
    "chat.prepare_assistant_reply",
    "chat.prepare_assistant_reply",
    logContext,
    async () => {
      setSpanAttributes({
        "app.ai.output_router.input_char_count": originalText.length,
        "app.ai.output_router.soft_max_chars": OUTPUT_REPLY_SOFT_MAX_CHARS,
      });

      try {
        const result = await args.completeObject({
          modelId: args.fastModelId,
          schema: preparedReplySchema,
          maxTokens: OUTPUT_ROUTER_MAX_TOKENS,
          metadata: {
            modelId: args.fastModelId,
            conversationId: args.context?.conversationId ?? "",
            runId: args.context?.runId ?? "",
          },
          prompt: buildUserPrompt(originalText),
          thinkingLevel: "low",
          system: buildSystemPrompt(),
          temperature: 0,
          promptName: "junior.prepare_assistant_reply",
        });

        const prepared = finalizeModelResult(
          result.object,
          originalText,
          result.costUsd,
        );
        setSpanAttributes({
          "app.ai.output_router.kind": prepared.kind,
          "app.ai.output_router.reason": prepared.reason,
          ...(prepared.kind === "reply"
            ? { "app.ai.output_router.output_char_count": prepared.text.length }
            : undefined),
        });
        logInfo("ai.output_router.decided", {
          "app.ai.output_router.kind": prepared.kind,
          "app.ai.output_router.reason": prepared.reason,
          "app.ai.output_router.input_char_count": originalText.length,
          ...(prepared.kind === "reply"
            ? { "app.ai.output_router.output_char_count": prepared.text.length }
            : undefined),
        });
        return prepared;
      } catch (error) {
        logWarn("ai.output_router.failed", {
          "exception.message":
            error instanceof Error ? error.message : String(error),
        });
        // On failure, show the original text rather than dropping the reply.
        return reply(originalText, "prepare_failed");
      }
    },
  );
}

/**
 * Decide the visible reply for a completed assistant message.
 * Returns silent/skip without changing the agent message.
 */
export async function prepareAssistantMessage(args: {
  completeObject: CompleteObject;
  context?: {
    conversationId?: string;
    runId?: string;
  };
  fastModelId: string;
  message: AssistantMessage;
}): Promise<
  | { kind: "skip" }
  | { kind: "silent"; prepared: PreparedAssistantReply }
  | { kind: "reply"; text: string; prepared: PreparedAssistantReply }
> {
  const decision = decideReply(args.message);
  if (decision.kind !== "deliver") {
    return { kind: "skip" };
  }

  const prepared = await prepareAssistantReply({
    completeObject: args.completeObject,
    context: args.context,
    fastModelId: args.fastModelId,
    text: decision.text,
  });

  if (prepared.kind === "silent") {
    return { kind: "silent", prepared };
  }
  return { kind: "reply", text: prepared.text, prepared };
}
