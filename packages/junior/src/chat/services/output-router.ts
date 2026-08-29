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
import {
  decideReply,
  sanitizeAssistantText,
} from "@/chat/services/assistant-reply";
import { extractAssistantText } from "@/chat/pi/transcript";

/**
 * Destination reply length budget used by the optional output router.
 * Matches the Slack output prompt target (~1–5 sentences).
 */
export const OUTPUT_REPLY_SOFT_MAX_CHARS = 800;
/** Hard cap after rewrite; longer routed text is truncated deterministically. */
export const OUTPUT_REPLY_HARD_MAX_CHARS = 1_200;
const OUTPUT_ROUTER_MAX_TOKENS = 1_600;
const OUTPUT_ROUTER_PROMPT_MAX_CHARS = 12_000;

const outputRouteSchema = z
  .object({
    action: z.enum(["deliver", "suppress", "rewrite"]),
    text: z.string().optional(),
    reason: z.string().min(1),
  })
  .strict();

export type OutputRouteAction = z.infer<typeof outputRouteSchema>["action"];

export type OutputRoute = {
  action: "deliver" | "suppress";
  costUsd?: number;
  reason: string;
  source: "deterministic" | "router" | "fallback";
  text?: string;
};

type CompleteObject = (args: {
  modelId: string;
  schema: typeof outputRouteSchema;
  maxTokens: number;
  metadata: Record<string, string>;
  prompt: string;
  thinkingLevel?: "low" | "medium" | "high" | "xhigh";
  system: string;
  temperature: number;
  promptName?: string;
}) => Promise<{ costUsd?: number; object: unknown }>;

function buildOutputRouterSystemPrompt(): string {
  // Tight output guardrail. Pattern: OpenAI cookbook "output guardrails"
  // (validate LLM output before delivery) + structured JSON decisions.
  // https://developers.openai.com/cookbook/examples/how_to_use_guardrails/
  return [
    "You are Junior's final output router.",
    "Input is one completed assistant message. No other context is available.",
    "Decide the destination-visible reply before delivery.",
    "",
    "Actions:",
    "- suppress: no visible reply should be delivered",
    "- deliver: keep the message text as-is",
    "- rewrite: replace the message with shorter destination-visible text",
    "",
    "Rules:",
    `1. suppress when the whole message is intentional silence (exact ${NO_REPLY_MARKER}, or equivalent pure no-reply protocol text with no other answer).`,
    `2. if ${NO_REPLY_MARKER} appears mixed with real answer text, rewrite: strip the marker and keep the answer.`,
    "3. deliver short complete answers unchanged.",
    `4. rewrite long answers that exceed ~${OUTPUT_REPLY_SOFT_MAX_CHARS} characters unless the user clearly asked for full detail, a long dump, or a large code/config block that must stay intact.`,
    "5. rewrites must stay faithful: keep the outcome, decisive evidence, blockers, links, and required next actions. Do not invent facts.",
    `6. rewritten text should usually be 1–5 sentences and under ${OUTPUT_REPLY_SOFT_MAX_CHARS} characters. Prefer a short summary plus a pointer (for example a canvas/doc link) when detail is too long.`,
    "7. preserve fenced code only when it is essential and still short enough; otherwise summarize and point to where the full content lives.",
    "8. never add preamble, meta commentary, or process narration.",
    "",
    "Return JSON only with action, reason, and text.",
    "text is required for deliver and rewrite; omit text for suppress.",
    "reason is one short sentence.",
  ].join("\n");
}

function buildOutputRouterPrompt(text: string): string {
  const body =
    text.length <= OUTPUT_ROUTER_PROMPT_MAX_CHARS
      ? text
      : `${text.slice(0, OUTPUT_ROUTER_PROMPT_MAX_CHARS)}\n…[truncated]…`;
  return ["<assistant-message>", body, "</assistant-message>"].join("\n");
}

function normalizeRoutedText(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const normalized = sanitizeAssistantText(text);
  return normalized || undefined;
}

function enforceHardCap(text: string): string {
  if (text.length <= OUTPUT_REPLY_HARD_MAX_CHARS) {
    return text;
  }
  return `${text.slice(0, OUTPUT_REPLY_HARD_MAX_CHARS - 1).trimEnd()}…`;
}

function stripNoReplyMarker(text: string): string {
  return sanitizeAssistantText(
    text
      .split(NO_REPLY_MARKER)
      .join(" ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n"),
  );
}

/** Deterministic pre-checks before spending a model call. */
export function decideOutputRouteDeterministic(text: string): OutputRoute | null {
  const trimmed = sanitizeAssistantText(text);
  if (!trimmed) {
    return {
      action: "suppress",
      reason: "empty_text",
      source: "deterministic",
    };
  }
  if (isNoReplyMarker(trimmed)) {
    return {
      action: "suppress",
      reason: "no_reply_marker",
      source: "deterministic",
    };
  }
  if (trimmed.includes(NO_REPLY_MARKER)) {
    const stripped = stripNoReplyMarker(trimmed);
    if (!stripped) {
      return {
        action: "suppress",
        reason: "no_reply_marker_only_after_strip",
        source: "deterministic",
      };
    }
    return {
      action: "deliver",
      text: enforceHardCap(stripped),
      reason: "stripped_mixed_no_reply_marker",
      source: "deterministic",
    };
  }
  return null;
}

function finalizeRouterObject(
  object: unknown,
  originalText: string,
  costUsd?: number,
): OutputRoute {
  const parsed = outputRouteSchema.parse(object);
  const reason = parsed.reason.trim() || "router";

  if (parsed.action === "suppress") {
    return {
      action: "suppress",
      reason,
      source: "router",
      ...(costUsd !== undefined ? { costUsd } : undefined),
    };
  }

  const candidate =
    normalizeRoutedText(parsed.text) ??
    (parsed.action === "deliver" ? originalText : undefined);
  if (!candidate) {
    return {
      action: "deliver",
      text: originalText,
      reason: `router_missing_text:${reason}`,
      source: "fallback",
      ...(costUsd !== undefined ? { costUsd } : undefined),
    };
  }

  // Never let a rewrite reintroduce pure silence unless suppress was chosen.
  if (isNoReplyMarker(candidate)) {
    return {
      action: "suppress",
      reason: `router_rewrote_to_no_reply:${reason}`,
      source: "router",
      ...(costUsd !== undefined ? { costUsd } : undefined),
    };
  }

  return {
    action: "deliver",
    text: enforceHardCap(
      candidate.includes(NO_REPLY_MARKER)
        ? stripNoReplyMarker(candidate)
        : candidate,
    ),
    reason,
    source: "router",
    ...(costUsd !== undefined ? { costUsd } : undefined),
  };
}

/** Route one assistant message text before destination delivery. */
export async function routeAssistantOutput(args: {
  completeObject: CompleteObject;
  context?: {
    conversationId?: string;
    runId?: string;
  };
  fastModelId: string;
  text: string;
}): Promise<OutputRoute> {
  const originalText = sanitizeAssistantText(args.text);
  const deterministic = decideOutputRouteDeterministic(originalText);
  if (deterministic) {
    return deterministic;
  }

  const logContext: LogContext = {
    messageConversationId: args.context?.conversationId,
    runId: args.context?.runId,
    modelId: args.fastModelId,
  };

  return withSpan(
    "chat.route_assistant_output",
    "chat.route_assistant_output",
    logContext,
    async () => {
      setSpanAttributes({
        "app.ai.output_router.input_char_count": originalText.length,
        "app.ai.output_router.soft_max_chars": OUTPUT_REPLY_SOFT_MAX_CHARS,
      });

      try {
        const result = await args.completeObject({
          modelId: args.fastModelId,
          schema: outputRouteSchema,
          maxTokens: OUTPUT_ROUTER_MAX_TOKENS,
          metadata: {
            modelId: args.fastModelId,
            conversationId: args.context?.conversationId ?? "",
            runId: args.context?.runId ?? "",
          },
          prompt: buildOutputRouterPrompt(originalText),
          thinkingLevel: "low",
          system: buildOutputRouterSystemPrompt(),
          temperature: 0,
          promptName: "junior.output_route",
        });

        const routed = finalizeRouterObject(
          result.object,
          originalText,
          result.costUsd,
        );
        setSpanAttributes({
          "app.ai.output_router.action": routed.action,
          "app.ai.output_router.source": routed.source,
          "app.ai.output_router.reason": routed.reason,
          ...(routed.text
            ? { "app.ai.output_router.output_char_count": routed.text.length }
            : undefined),
        });
        logInfo("ai.output_router.decided", {
          "app.ai.output_router.action": routed.action,
          "app.ai.output_router.source": routed.source,
          "app.ai.output_router.reason": routed.reason,
          "app.ai.output_router.input_char_count": originalText.length,
          ...(routed.text
            ? { "app.ai.output_router.output_char_count": routed.text.length }
            : undefined),
        });
        return routed;
      } catch (error) {
        logWarn("ai.output_router.failed", {
          "exception.message":
            error instanceof Error ? error.message : String(error),
        });
        // Fail open: keep the original deliverable text rather than blocking the turn.
        return {
          action: "deliver",
          text: originalText,
          reason: "classifier_error_passthrough",
          source: "fallback",
        };
      }
    },
  );
}

/**
 * Replace assistant text content parts while preserving non-text parts.
 * Mutates in place so agent-history object identity stays stable for delivery.
 */
export function applyAssistantOutputText(
  message: AssistantMessage,
  text: string,
): AssistantMessage {
  const content = message.content ?? [];
  let replaced = false;
  const nextContent = content.map((part) => {
    if (part.type !== "text") {
      return part;
    }
    if (replaced) {
      return { ...part, text: "" };
    }
    replaced = true;
    return { ...part, text };
  });
  if (!replaced) {
    nextContent.unshift({ type: "text", text });
  }
  message.content = nextContent.filter(
    (part) => part.type !== "text" || part.text.length > 0,
  ) as AssistantMessage["content"];
  return message;
}

/** Route one completed assistant message when the experimental feature is on. */
export async function routeAssistantMessage(args: {
  completeObject: CompleteObject;
  context?: {
    conversationId?: string;
    runId?: string;
  };
  fastModelId: string;
  message: AssistantMessage;
}): Promise<
  | { kind: "deliver"; message: AssistantMessage; route: OutputRoute }
  | { kind: "suppress"; route: OutputRoute }
  | { kind: "skip" }
> {
  const decision = decideReply(args.message);
  if (decision.kind !== "deliver") {
    return { kind: "skip" };
  }

  const route = await routeAssistantOutput({
    completeObject: args.completeObject,
    context: args.context,
    fastModelId: args.fastModelId,
    text: decision.text,
  });

  if (route.action === "suppress") {
    return { kind: "suppress", route };
  }

  const nextText = route.text ?? decision.text;
  if (nextText !== decision.text) {
    applyAssistantOutputText(args.message, nextText);
  } else if (sanitizeAssistantText(extractAssistantText(args.message)) !== nextText) {
    applyAssistantOutputText(args.message, nextText);
  }

  return { kind: "deliver", message: args.message, route };
}
