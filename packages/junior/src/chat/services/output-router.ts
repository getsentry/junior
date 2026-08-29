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
 * Prompt design:
 * - task first, short imperative rules
 * - one structured output contract
 * - personality from SOUL.md so rewrites keep the bot's voice
 * OpenAI structured outputs + short instructions; Anthropic: be direct.
 */
function buildSystemPrompt(personality: string = JUNIOR_PERSONALITY): string {
  return [
    "Edit one assistant message into the final user-visible reply.",
    "You receive only that message. No other conversation context.",
    "",
    "Return JSON:",
    "- text: the visible reply, or null for no visible reply",
    "- reason: one short sentence",
    "",
    "Rules:",
    `- Set text to null when there is no user-facing answer: empty text, only ${NO_REPLY_MARKER}, or internal status/process notes meant only for silence.`,
    `- Treat trailing ${NO_REPLY_MARKER} as intentional silence when the rest is internal work status, not an answer to the user. Do not keep those notes as a reply.`,
    `- A real user-facing answer must stay a reply even if it contains ${NO_REPLY_MARKER}. That includes explanations of how silence works, quotes of the marker, or discussion of the protocol.`,
    `- If ${NO_REPLY_MARKER} is only a trailing silence tag after a real user-facing answer, keep the answer and drop the tag.`,
    `- If the answer itself is about the marker, keep the marker text when the user needs it.`,
    `- Keep short clear replies as-is (about ${OUTPUT_REPLY_SOFT_MAX_CHARS} characters or less).`,
    "- If the reply is too long, shorten it. Keep the answer, key facts, links, and next steps. Do not add facts.",
    "- Prefer 1-5 short sentences when shortening.",
    "- Do not add a preface or meta commentary.",
    "- These rules override personality when they conflict.",
    "",
    "# Personality",
    "When you keep or rewrite text, match this voice and tone:",
    personality.trim(),
  ].join("\n");
}

function buildUserPrompt(text: string): string {
  const body =
    text.length <= OUTPUT_ROUTER_PROMPT_MAX_CHARS
      ? text
      : `${text.slice(0, OUTPUT_ROUTER_PROMPT_MAX_CHARS)}\n…[truncated]…`;
  return body;
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
 * Only exact silence stays local. Mixed marker cases need judgment.
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
  // Exact marker-only output is silence. Otherwise trust the model text,
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
